import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { replay } from '../src/eodhd/replay.js';

// Cuerpos sintéticos con la forma real de eod de un cruce FOREX (date, open, high, low, close, adjusted_close, volume).
async function cleanAll() {
  for (const sql of ['DELETE FROM fx_rates', 'DELETE FROM prices_daily', 'DELETE FROM data_quality_finding', 'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run']) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(async () => { runId = ''; await cleanAll(); });

let runId = '';
async function eod(symbol: string, body: unknown, status = 200): Promise<string> {
  if (!runId) runId = (await pool.query<{ id: string }>("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd', 'test:fx', 'ok', now()) RETURNING ingestion_run_id AS id")).rows[0]!.id;
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query('INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [hash, bytes, bytes.length]);
  return (await pool.query<{ id: string }>(
    'INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING raw_payload_id AS id',
    [runId, 'eod/{symbol}', symbol, JSON.stringify({ period: 'd', order: 'a' }), status, hash],
  )).rows[0]!.id;
}
const bar = (date: string, close: number | string) => ({ date, open: close, high: close, low: close, close, adjusted_close: close, volume: 0 });
const rates = async () => (await pool.query('SELECT currency, date::text AS date, rate_to_base::text AS rate FROM fx_rates ORDER BY currency, date')).rows;

describe('escritor de FX', () => {
  test('rate_to_base = 1 / close (valor de 1 unidad en EUR); no se escribe fila EUR; no toca prices_daily', async () => {
    await eod('EURUSD.FOREX', [bar('2026-10-09', 1.25), bar('2026-10-12', '1.11597')]);
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0, deferred: 0 });
    expect(out.fx).toMatchObject({ payloads: 1, rows: 2, inserted: 2, revised: 0, subunitRows: 0 });
    const r = await rates();
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ currency: 'USD', date: '2026-10-09', rate: '0.80000000000000000000' });
    expect(Number(r[1]!.rate)).toBeCloseTo(1 / 1.11597, 12);
    expect((await pool.query("SELECT count(*)::int AS n FROM prices_daily")).rows[0].n).toBe(0);
  });

  test('GBX = GBP / 100 como fila propia, a partir de la fila GBP del mismo día', async () => {
    await eod('EURGBP.FOREX', [bar('2026-10-09', 0.8), bar('2026-10-12', 0.5)]);
    const out = await replay();
    expect(out.fx).toMatchObject({ inserted: 4, subunitRows: 2 });
    expect((await rates()).map((x) => `${x.currency} ${x.date}`)).toEqual(['GBP 2026-10-09', 'GBP 2026-10-12', 'GBX 2026-10-09', 'GBX 2026-10-12']);
    const byKey = Object.fromEntries((await rates()).map((x) => [`${x.currency} ${x.date}`, Number(x.rate)]));
    expect(byKey['GBP 2026-10-09']).toBeCloseTo(1.25, 12);
    expect(byKey['GBX 2026-10-09']).toBeCloseTo(0.0125, 12);
    expect(byKey['GBX 2026-10-12']! * 100).toBeCloseTo(byKey['GBP 2026-10-12']!, 12);
  });

  test('idempotente: repetir deja las mismas filas y 0 cambios', async () => {
    await eod('EURGBP.FOREX', [bar('2026-10-09', 0.8)]);
    await replay();
    const before = await rates();
    const again = await replay({ all: true });
    expect(again.fx).toMatchObject({ inserted: 0, revised: 0, unchanged: 1 });
    expect(await rates()).toEqual(before);
  });

  test('una revisión del proveedor para una fecha ya guardada se acepta en silencio (D10), también en la subunidad', async () => {
    await eod('EURGBP.FOREX', [bar('2026-10-12', 0.8)]);
    await replay();
    await eod('EURGBP.FOREX', [bar('2026-10-12', 0.5)]); // el último cierre se mueve durante el día
    const out = await replay({ all: true });
    expect(out.fx).toMatchObject({ inserted: 0, revised: 2 }); // GBP y GBX
    const byKey = Object.fromEntries((await rates()).map((x) => [x.currency, Number(x.rate)]));
    expect(byKey.GBP).toBeCloseTo(2, 12);
    expect(byKey.GBX).toBeCloseTo(0.02, 12);
    expect((await pool.query('SELECT count(*)::int AS n FROM data_quality_finding')).rows[0].n).toBe(0);
  });

  test('close ausente, cero o negativo, fecha inválida y fecha repetida: se descartan contando', async () => {
    await eod('EURCAD.FOREX', [bar('2026-10-06', 1.5), { date: '2026-10-07', close: null }, bar('2026-10-08', 0), bar('2026-10-09', -1), { date: 'x', close: 1.5 }, bar('2026-10-06', 9)]);
    const out = await replay();
    expect(out.fx).toMatchObject({ rows: 6, inserted: 1, skippedNoRate: 3, skippedBadDate: 1 });
    expect(await rates()).toEqual([{ currency: 'CAD', date: '2026-10-06', rate: expect.any(String) }]);
  });

  test('un símbolo .FOREX que no es EURxxx marca error; un 403 del proveedor también', async () => {
    const a = await eod('USDEUR.FOREX', [bar('2026-10-09', 0.9)]);
    const b = await eod('EURGBP.FOREX', 'Forbidden', 403);
    const out = await replay();
    expect(out).toMatchObject({ checked: 2, error: 2 });
    const e = (id: string) => pool.query('SELECT parse_error FROM raw_payload WHERE raw_payload_id = $1', [id]).then((r) => r.rows[0].parse_error as string);
    expect(await e(a)).toMatch(/EURxxx/);
    expect(await e(b)).toMatch(/HTTP 403/);
    expect(await rates()).toHaveLength(0);
  });
});
