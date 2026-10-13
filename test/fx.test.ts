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
const rates = async () => (await pool.query('SELECT currency, date::text AS date, units_per_base::text AS rate FROM fx_rates ORDER BY currency, date')).rows;
const findings = async () => (await pool.query("SELECT target_table, target_key, severity, status, detail FROM data_quality_finding WHERE rule_code = 'PRICE_REVISED' ORDER BY finding_id")).rows;
// 8 fechas laborables: la ventana de "últimas sesiones" son las 5 últimas, así que las 3 primeras quedan fuera
const eight = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];

describe('escritor de FX', () => {
  test('units_per_base = el close del payload TAL CUAL (texto exacto, sin redondeo); no se escribe fila EUR; no toca prices_daily', async () => {
    await eod('EURUSD.FOREX', '[{"date":"2026-10-09","open":1.25,"high":1.25,"low":1.25,"close":1.2500,"adjusted_close":1.25,"volume":0},{"date":"2026-10-12","close":1.11597},{"date":"2026-10-13","close":1.123456789012345678}]');
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0, deferred: 0 });
    expect(out.fx).toMatchObject({ payloads: 1, rows: 3, inserted: 3, revised: 0, subunitRows: 0 });
    expect(await rates()).toEqual([
      { currency: 'USD', date: '2026-10-09', rate: '1.2500' },
      { currency: 'USD', date: '2026-10-12', rate: '1.11597' },
      { currency: 'USD', date: '2026-10-13', rate: '1.123456789012345678' },
    ]);
    expect((await pool.query("SELECT count(*)::int AS n FROM prices_daily")).rows[0].n).toBe(0);
  });

  test('GBX = units_per_base de GBP x 100 como fila propia, a partir de la fila GBP del mismo día', async () => {
    await eod('EURGBP.FOREX', '[{"date":"2026-10-09","close":0.8593},{"date":"2026-10-12","close":0.86475}]');
    const out = await replay();
    expect(out.fx).toMatchObject({ inserted: 4, subunitRows: 2 });
    expect(await rates()).toEqual([
      { currency: 'GBP', date: '2026-10-09', rate: '0.8593' },
      { currency: 'GBP', date: '2026-10-12', rate: '0.86475' },
      { currency: 'GBX', date: '2026-10-09', rate: '85.9300' },
      { currency: 'GBX', date: '2026-10-12', rate: '86.47500' },
    ]);
  });

  test('idempotente: repetir deja las mismas filas y 0 cambios', async () => {
    await eod('EURGBP.FOREX', [bar('2026-10-09', 0.8)]);
    await replay();
    const before = await rates();
    const again = await replay({ all: true });
    expect(again.fx).toMatchObject({ inserted: 0, revised: 0, settled: 0, unchanged: 1 });
    expect(await rates()).toEqual(before);
  });

  test('revisión dentro de las últimas sesiones: UPDATE en silencio, también en la subunidad', async () => {
    await eod('EURGBP.FOREX', eight.map((d) => bar(d, 0.8)));
    await replay();
    await eod('EURGBP.FOREX', eight.map((d) => bar(d, d === '2026-10-09' ? 0.5 : 0.8))); // el último cierre se mueve durante el día
    const out = await replay({ all: true });
    expect(out.fx).toMatchObject({ inserted: 0, revised: 0, settled: 2 }); // GBP y GBX
    const byKey = Object.fromEntries((await rates()).filter((x) => x.date === '2026-10-09').map((x) => [x.currency, Number(x.rate)]));
    expect(byKey).toEqual({ GBP: 0.5, GBX: 50 });
    expect(await findings()).toHaveLength(0);
  });

  test('revisión fuera de las últimas sesiones: UPDATE + PRICE_REVISED {currency, date}; un segundo cambio conserva el old del primero', async () => {
    await eod('EURUSD.FOREX', eight.map((d) => bar(d, 1.1)));
    await replay();
    await eod('EURUSD.FOREX', eight.map((d) => bar(d, d === '2026-09-30' ? 1.2 : 1.1)));
    const out = await replay({ all: true });
    expect(out.fx).toMatchObject({ revised: 1, settled: 0 });
    expect((await rates())[0]).toEqual({ currency: 'USD', date: '2026-09-30', rate: '1.2' });
    let f = await findings();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      target_table: 'fx_rates', target_key: { currency: 'USD', date: '2026-09-30' }, severity: 'warning', status: 'open',
      detail: { old: { units_per_base: '1.1' }, new: { units_per_base: '1.2' } },
    });
    await eod('EURUSD.FOREX', eight.map((d) => bar(d, d === '2026-09-30' ? 1.3 : 1.1)));
    await replay({ all: true });
    f = await findings();
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toEqual({ old: { units_per_base: '1.1' }, new: { units_per_base: '1.3' } });
  });

  test('close ausente, cero o negativo, fecha inválida y fecha repetida: se descartan contando', async () => {
    await eod('EURCAD.FOREX', [bar('2026-10-06', 1.5), { date: '2026-10-07', close: null }, bar('2026-10-08', 0), bar('2026-10-09', -1), { date: 'x', close: 1.5 }, bar('2026-10-06', 9)]);
    const out = await replay();
    expect(out.fx).toMatchObject({ rows: 6, inserted: 1, skippedNoRate: 3, skippedBadDate: 1 });
    expect(await rates()).toEqual([{ currency: 'CAD', date: '2026-10-06', rate: '1.5' }]);
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
