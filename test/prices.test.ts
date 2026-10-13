import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { replay } from '../src/eodhd/replay.js';
import { parseJsonExact } from '../src/normalizer/prices.js';

// Cuerpos sintéticos con la forma real de eod (date, open, high, low, close, adjusted_close, volume). Los valores son de prueba.
async function cleanAll() {
  for (const sql of [
    'DELETE FROM data_quality_finding', 'DELETE FROM prices_daily', 'DELETE FROM listing', 'DELETE FROM security', 'DELETE FROM company',
    'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run',
    "DELETE FROM dimension_audit WHERE table_name IN ('company', 'security', 'listing')",
  ]) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(async () => { runId = ''; await cleanAll(); });

let runId = '';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function addPayload(endpoint: string, symbol: string | null, params: Record<string, string>, body: unknown): Promise<string> {
  if (!runId) runId = (await pool.query<{ id: string }>("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd', 'test:precios', 'ok', now()) RETURNING ingestion_run_id AS id")).rows[0]!.id;
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const hash = sha(bytes);
  await pool.query('INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [hash, bytes, bytes.length]);
  return (await pool.query<{ id: string }>(
    'INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash) VALUES ($1,$2,$3,$4::jsonb,200,$5) RETURNING raw_payload_id AS id',
    [runId, endpoint, symbol, JSON.stringify(params), hash],
  )).rows[0]!.id;
}
const eod = (symbol: string, rows: unknown, params: Record<string, string> = { period: 'd', order: 'a' }) => addPayload('eod/{symbol}', symbol, params, rows);
const bar = (date: string, close: number | string, over: Record<string, unknown> = {}) => ({ date, open: close, high: close, low: close, close, adjusted_close: close, volume: 1000, ...over });
// Un ETF con su listing, creado a mano (el escritor de listings tiene sus propios tests).
async function makeListing(providerSymbol: string, quoteCurrency = 'USD') {
  const sec = (await pool.query<{ id: string }>("INSERT INTO security (company_id, asset_type_id) VALUES (NULL, (SELECT asset_type_id FROM asset_type WHERE code = 'etf')) RETURNING security_id AS id")).rows[0]!.id;
  return (await pool.query<{ id: string }>(
    "INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency, status, is_primary_listing) VALUES ($1, $2, $3, $4, 'active', true) RETURNING listing_id AS id",
    [sec, providerSymbol.split('.')[0], providerSymbol, quoteCurrency],
  )).rows[0]!.id;
}
const prices = async (listingId: string) => (await pool.query('SELECT date::text AS date, open::text AS open, high::text AS high, low::text AS low, close::text AS close, volume::text AS volume FROM prices_daily WHERE listing_id = $1 ORDER BY date', [listingId])).rows;
const count = async (table: string) => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
const findings = async () => (await pool.query("SELECT target_table, target_key, severity, status, detail FROM data_quality_finding WHERE rule_code = 'PRICE_REVISED' ORDER BY finding_id")).rows;

describe('parseJsonExact', () => {
  test('los números salen como el texto exacto del cuerpo', () => {
    expect(parseJsonExact('{"a": 214.2300, "b": 1e-7, "c": "x", "d": [1, 2.50], "e": null, "f": 12345678901234567890}')).toEqual({ a: '214.2300', b: '1e-7', c: 'x', d: ['1', '2.50'], e: null, f: '12345678901234567890' });
  });
});

describe('escritor de precios brutos', () => {
  test('inserta open, high, low, close y volume tal cual; adjusted_close no se guarda; los decimales conservan su escala', async () => {
    const l = await makeListing('AAA.US');
    // texto JSON escrito a mano: JSON.stringify de un número de JavaScript perdería los ceros finales (215.2500)
    await eod('AAA.US', '[{"date":"2026-10-08","open":214.1,"high":215.2500,"low":213.9,"close":214.2300,"adjusted_close":99.99,"volume":53000000},{"date":"2026-10-09","open":214.3,"high":216,"low":214,"close":215.5,"adjusted_close":100.01,"volume":48000000.5}]');
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0, deferred: 0 });
    expect(out.prices).toMatchObject({ payloads: 1, rows: 2, inserted: 2, unchanged: 0, revised: 0 });
    expect(await prices(l)).toEqual([
      { date: '2026-10-08', open: '214.1', high: '215.2500', low: '213.9', close: '214.2300', volume: '53000000' },
      { date: '2026-10-09', open: '214.3', high: '216', low: '214', close: '215.5', volume: '48000000.5' },
    ]);
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'prices_daily'")).rows.map((r) => r.column_name);
    expect(cols).not.toContain('adjusted_close');
  });

  test('un precio en subunidad se guarda sin dividir: SHEL en GBX cierra en 3793,5', async () => {
    const l = await makeListing('SHEL.LSE', 'GBX');
    await eod('SHEL.LSE', [bar('2026-10-09', 3793.5)]);
    await replay();
    expect((await prices(l))[0]).toMatchObject({ close: '3793.5' });
    expect((await pool.query('SELECT quote_currency FROM listing WHERE listing_id = $1', [l])).rows[0].quote_currency).toBe('GBX');
  });

  test('filas sin close, con fecha inválida o repetidas se saltan y se cuentan; el resto entra', async () => {
    const l = await makeListing('BBB.US');
    await eod('BBB.US', [
      bar('2026-10-01', 10), { date: '2026-10-02', open: 1, high: 1, low: 1, close: null, volume: 5 }, { date: 'ayer', close: 7 }, { close: 7 },
      bar('2026-10-03', 11), bar('2026-10-03', 999), bar('2026-10-04', 12, { open: null, high: null, low: null, volume: null }),
    ]);
    const out = await replay();
    expect(out.prices).toMatchObject({ rows: 7, inserted: 3, skippedNoClose: 1, skippedBadDate: 2, skippedDuplicate: 1 });
    expect((await prices(l)).map((r) => [r.date, r.close])).toEqual([['2026-10-01', '10'], ['2026-10-03', '11'], ['2026-10-04', '12']]); // la primera de una fecha repetida gana
    expect((await pool.query("SELECT open, high, low, volume FROM prices_daily WHERE date = '2026-10-04'")).rows[0]).toEqual({ open: null, high: null, low: null, volume: null });
  });

  test('idempotente: dos pasadas dejan las mismas filas y ningún finding; 223.2300 frente a 223.23 no es una revisión', async () => {
    const l = await makeListing('CCC.US');
    await eod('CCC.US', [bar('2026-10-08', '223.2300'), bar('2026-10-09', 224)]);
    await replay();
    const antes = await prices(l);
    const second = await replay({ all: true });
    expect(second.prices).toMatchObject({ inserted: 0, unchanged: 2, revised: 0 });
    expect(await prices(l)).toEqual(antes);
    await eod('CCC.US', [bar('2026-10-08', 223.23), bar('2026-10-09', '224.000')]); // mismos valores con otra escala
    const third = await replay({ all: true });
    expect(third.prices).toMatchObject({ inserted: 0, unchanged: 2, revised: 0 });
    expect(await count('data_quality_finding')).toBe(0);
    expect(await prices(l)).toEqual(antes); // y lo guardado no se toca
  });

  test('un payload nuevo añade fechas nuevas y respeta las ya guardadas', async () => {
    const l = await makeListing('DDD.US');
    await eod('DDD.US', [bar('2026-10-08', 10), bar('2026-10-09', 11)]);
    await replay();
    await eod('DDD.US', [bar('2026-10-09', 11), bar('2026-10-10', 12)]);
    const out = await replay({ all: true });
    expect(out.prices).toMatchObject({ inserted: 1, unchanged: 1, revised: 0 });
    expect((await prices(l)).map((r) => r.date)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
  });
});

describe('el precio bruto es inmutable (D9, provisional)', () => {
  test('una fecha con otro valor no se sobrescribe y emite PRICE_REVISED con el valor guardado y el nuevo', async () => {
    const l = await makeListing('EEE.US');
    await eod('EEE.US', [bar('2026-10-08', 100), bar('2026-10-09', 101)]);
    await replay();
    await eod('EEE.US', [bar('2026-10-08', 100), bar('2026-10-09', 150, { volume: 5 })]); // el proveedor "corrige" el 9
    const out = await replay({ all: true });
    expect(out.prices).toMatchObject({ inserted: 0, unchanged: 1, revised: 1 });
    expect((await prices(l)).find((r) => r.date === '2026-10-09')).toMatchObject({ close: '101', volume: '1000' }); // se conserva el guardado
    const f = await findings();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      target_table: 'prices_daily', target_key: { listing_id: Number(l), date: '2026-10-09' }, severity: 'warning', status: 'open',
      detail: { stored: { open: 101, high: 101, low: 101, close: 101, volume: 1000 }, incoming: { open: 150, high: 150, low: 150, close: 150, volume: 5 } },
    });
  });

  test('repetir no duplica el finding; uno aceptado con el mismo detail no se reabre; con otro valor nuevo se actualiza el abierto', async () => {
    const l = await makeListing('FFF.US');
    await eod('FFF.US', [bar('2026-10-09', 101)]);
    await replay();
    await eod('FFF.US', [bar('2026-10-09', 150)]);
    await replay({ all: true });
    await replay({ all: true });
    expect(await findings()).toHaveLength(1);
    await pool.query("UPDATE data_quality_finding SET status = 'accepted', resolved_at = now(), resolved_by = 'david'");
    await replay({ all: true });
    expect(await findings()).toHaveLength(1);
    expect((await findings())[0]).toMatchObject({ status: 'accepted' });
    await eod('FFF.US', [bar('2026-10-09', 175)]); // otro valor: es un hecho nuevo
    await replay({ all: true });
    const f = await findings();
    expect(f.map((x) => x.status)).toEqual(['accepted', 'open']);
    expect((await prices(l))[0]).toMatchObject({ close: '101' });
  });

  test('una regla apagada no emite el finding pero tampoco sobrescribe', async () => {
    const l = await makeListing('GGG.US');
    await eod('GGG.US', [bar('2026-10-09', 101)]);
    await replay();
    await pool.query("UPDATE validation_rule SET enabled = false WHERE rule_code = 'PRICE_REVISED'");
    try {
      await eod('GGG.US', [bar('2026-10-09', 150)]);
      const out = await replay({ all: true });
      expect(out.prices).toMatchObject({ revised: 1 });
      expect(await findings()).toHaveLength(0);
      expect((await prices(l))[0]).toMatchObject({ close: '101' });
    } finally {
      await pool.query("UPDATE validation_rule SET enabled = true WHERE rule_code = 'PRICE_REVISED'");
    }
  });
});

describe('dependencia del listing y errores', () => {
  test('precios de un símbolo sin listing: el payload sigue pendiente (no se pierde) y se escribe en el siguiente replay', async () => {
    const id = await eod('HHH.US', [bar('2026-10-09', 50)]);
    const first = await replay();
    expect(first).toMatchObject({ checked: 0, deferred: 1 });
    expect((await pool.query('SELECT parse_status FROM raw_payload WHERE raw_payload_id = $1', [id])).rows[0].parse_status).toBe('pending');
    expect(await count('prices_daily')).toBe(0);
    const l = await makeListing('HHH.US');
    const second = await replay();
    expect(second).toMatchObject({ checked: 1, ok: 1, deferred: 0 });
    expect(await prices(l)).toHaveLength(1);
    expect((await pool.query('SELECT parse_status FROM raw_payload WHERE raw_payload_id = $1', [id])).rows[0].parse_status).toBe('ok');
  });

  test('en un solo replay: el payload de precios capturado ANTES que la lista de símbolos se escribe después de crear el listing', async () => {
    await eod('ZZE.LSE', [bar('2026-10-09', 77)]); // primero los precios
    await addPayload('exchange-symbol-list/{code}', null, { code: 'LSE' }, [{ Code: 'ZZE', Name: 'ETF de prueba', Country: 'UK', Exchange: 'LSE', Currency: 'GBX', Type: 'ETF', Isin: 'GB00TEST9001' }]); // luego la lista
    const out = await replay();
    expect(out).toMatchObject({ checked: 2, ok: 2, error: 0, deferred: 0 });
    expect(out.listings).toMatchObject({ created: 1 });
    expect(out.prices).toMatchObject({ inserted: 1 });
    const l = (await pool.query<{ id: string }>("SELECT listing_id AS id FROM listing WHERE provider_symbol = 'ZZE.LSE'")).rows[0]!.id;
    expect(await prices(l)).toEqual([expect.objectContaining({ date: '2026-10-09', close: '77' })]);
  });

  test('un cuerpo que no es una lista de precios marca error y no escribe nada', async () => {
    const l = await makeListing('III.US');
    await eod('III.US', { error: 'no es una lista' });
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 0, error: 1 });
    expect((await pool.query("SELECT parse_error FROM raw_payload WHERE provider_symbol = 'III.US'")).rows[0].parse_error).toContain('escritor de precios');
    expect(await prices(l)).toHaveLength(0);
  });

  test('una lista vacía es válida y no escribe nada', async () => {
    await makeListing('JJJ.US');
    await eod('JJJ.US', []);
    expect(await replay()).toMatchObject({ checked: 1, ok: 1, error: 0 });
    expect(await count('prices_daily')).toBe(0);
  });

  test('replay de precios no usa la red', async () => {
    await makeListing('KKK.US');
    await eod('KKK.US', [bar('2026-10-09', 5)]);
    const mock = vi.fn(() => { throw new Error('sin red'); });
    vi.stubGlobal('fetch', mock);
    try { await replay(); } finally { vi.unstubAllGlobals(); }
    expect(mock).not.toHaveBeenCalled();
    expect(await count('prices_daily')).toBe(1);
  });

  test('un año de precios (5.000 filas) entra en una sola sentencia y de forma idempotente', async () => {
    const l = await makeListing('LLL.US');
    const rows = Array.from({ length: 5000 }, (_, i) => bar(new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10), 100 + (i % 50) / 10));
    await eod('LLL.US', rows);
    const t0 = Date.now();
    const out = await replay();
    expect(out.prices).toMatchObject({ rows: 5000, inserted: 5000 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await prices(l)).toHaveLength(5000);
    expect((await replay({ all: true })).prices).toMatchObject({ inserted: 0, unchanged: 5000 });
  });

  test('el escritor de precios no deja filas en dimension_audit (los hechos no se auditan)', async () => {
    await makeListing('MMM.US');
    const antes = await count('dimension_audit');
    await eod('MMM.US', [bar('2026-10-09', 5)]);
    await replay();
    expect(await count('dimension_audit')).toBe(antes);
  });
});
