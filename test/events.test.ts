import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { replay } from '../src/eodhd/replay.js';
import { parseSplitRatio } from '../src/normalizer/events.js';

// Cuerpos sintéticos con la forma real de div/ y splits/ (date, declarationDate, recordDate, paymentDate, period, value,
// unadjustedValue, currency) y ("date", "split": "N/M"). Los valores son de prueba.
async function cleanAll() {
  for (const sql of [
    'DELETE FROM data_quality_finding', 'DELETE FROM dividend', 'DELETE FROM stock_split', 'DELETE FROM listing', 'DELETE FROM security', 'DELETE FROM company',
    'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run',
    "DELETE FROM dimension_audit WHERE table_name IN ('company', 'security', 'listing')",
  ]) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(async () => { runId = ''; await cleanAll(); });

let runId = '';
async function addPayload(endpoint: string, symbol: string, body: unknown): Promise<string> {
  if (!runId) runId = (await pool.query<{ id: string }>("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd', 'test:eventos', 'ok', now()) RETURNING ingestion_run_id AS id")).rows[0]!.id;
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query('INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [hash, bytes, bytes.length]);
  return (await pool.query<{ id: string }>(
    'INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash) VALUES ($1,$2,$3,$4::jsonb,200,$5) RETURNING raw_payload_id AS id',
    [runId, endpoint, symbol, '{}', hash],
  )).rows[0]!.id;
}
const div = (symbol: string, rows: unknown) => addPayload('div/{symbol}', symbol, rows);
const splits = (symbol: string, rows: unknown) => addPayload('splits/{symbol}', symbol, rows);
const d = (date: string, unadjustedValue: number | string | null, over: Record<string, unknown> = {}) =>
  ({ date, declarationDate: null, recordDate: date, paymentDate: null, period: 'Quarterly', value: 0.01, unadjustedValue, currency: 'USD', ...over });

async function makeListing(providerSymbol: string) {
  const sec = (await pool.query<{ id: string }>("INSERT INTO security (company_id, asset_type_id) VALUES (NULL, (SELECT asset_type_id FROM asset_type WHERE code = 'etf')) RETURNING security_id AS id")).rows[0]!.id;
  await pool.query(
    "INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency, status, is_primary_listing) VALUES ($1, $2, $3, 'USD', 'active', true)",
    [sec, providerSymbol.split('.')[0], providerSymbol],
  );
  return sec;
}
const dividends = async () => (await pool.query('SELECT ex_date::text AS ex_date, declaration_date::text AS declaration_date, record_date::text AS record_date, payment_date::text AS payment_date, period, amount_native::text AS amount, currency FROM dividend ORDER BY ex_date')).rows;
const splitRows = async () => (await pool.query('SELECT ex_date::text AS ex_date, split_numerator::text AS n, split_denominator::text AS d FROM stock_split ORDER BY ex_date')).rows;
const findings = async (rule: string) => (await pool.query('SELECT target_table, target_key, severity, status, detail FROM data_quality_finding WHERE rule_code = $1 ORDER BY finding_id', [rule])).rows;
const count = async (table: string) => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

describe('parseSplitRatio', () => {
  test('N/M como texto exacto; ilegible o no positivo -> null', () => {
    expect(parseSplitRatio('4.000000/1.000000')).toEqual({ n: '4.000000', d: '1.000000' });
    expect(parseSplitRatio('959692.000000/319897.000000')).toEqual({ n: '959692.000000', d: '319897.000000' });
    for (const bad of [null, undefined, 3, '', '4', '4/', '0/1', '1/0', '-2/1', 'a/b', '1/2/3']) expect(parseSplitRatio(bad)).toBeNull();
  });
});

describe('escritor de dividendos', () => {
  test('amount_native = unadjustedValue (value, ajustado, no se guarda); fechas, period y divisa tal cual; period nulo se queda nulo', async () => {
    const sec = await makeListing('DDD.US');
    await div('DDD.US', [
      d('1987-05-11', '0.12096', { value: 0.00054, declarationDate: '1987-04-22', paymentDate: '1987-06-15', period: null }),
      d('2026-08-10', 0.27, { declarationDate: '2026-07-30', paymentDate: '2026-08-13' }),
    ]);
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0, deferred: 0 });
    expect(out.dividends).toMatchObject({ payloads: 1, rows: 2, inserted: 2, unchanged: 0, changed: 0 });
    expect(await dividends()).toEqual([
      { ex_date: '1987-05-11', declaration_date: '1987-04-22', record_date: '1987-05-11', payment_date: '1987-06-15', period: null, amount: '0.12096', currency: 'USD' },
      { ex_date: '2026-08-10', declaration_date: '2026-07-30', record_date: '2026-08-10', payment_date: '2026-08-13', period: 'Quarterly', amount: '0.27', currency: 'USD' },
    ]);
    expect((await pool.query('SELECT security_id::text AS s FROM dividend LIMIT 1')).rows[0].s).toBe(sec);
  });

  test('una lista vacía es válida (valores sin dividendos): marca ok y no escribe', async () => {
    await makeListing('NODIV.US');
    await div('NODIV.US', []);
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
    expect(await count('dividend')).toBe(0);
  });

  test('idempotente: la misma respuesta dos veces deja las mismas filas y ningún finding', async () => {
    await makeListing('IDM.US');
    await div('IDM.US', [d('2026-01-05', 0.5), d('2026-04-06', '0.5000')]);
    await replay();
    const again = await replay({ all: true });
    expect(again.dividends).toMatchObject({ inserted: 0, unchanged: 2, changed: 0, metaUpdated: 0 });
    expect(await count('dividend')).toBe(2);
    expect(await count('data_quality_finding')).toBe(0);
  });

  test('metadatos que cambian (period, fechas) se actualizan sin finding', async () => {
    await makeListing('MET.US');
    await div('MET.US', [d('2026-01-05', 0.5, { period: null, paymentDate: null })]);
    await replay();
    await div('MET.US', [d('2026-01-05', 0.5, { period: 'Quarterly', paymentDate: '2026-01-20' })]);
    const out = await replay({ all: true });
    expect(out.dividends).toMatchObject({ inserted: 0, changed: 0, metaUpdated: 1 });
    expect(await dividends()).toEqual([expect.objectContaining({ period: 'Quarterly', payment_date: '2026-01-20' })]);
    expect(await count('data_quality_finding')).toBe(0);
  });

  test('un importe o divisa corregidos se actualizan y emiten CORPORATE_EVENT_CHANGED; un segundo cambio conserva el old del primero', async () => {
    await makeListing('COR.US');
    await div('COR.US', [d('2026-01-05', 0.5)]);
    await replay();
    await div('COR.US', [d('2026-01-05', 0.55)]);
    const out = await replay({ all: true });
    expect(out.dividends).toMatchObject({ changed: 1 });
    expect(await dividends()).toEqual([expect.objectContaining({ amount: '0.55' })]);
    const id = (await pool.query('SELECT dividend_id FROM dividend')).rows[0].dividend_id;
    let f = await findings('CORPORATE_EVENT_CHANGED');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      target_table: 'dividend', target_key: { dividend_id: Number(id) }, severity: 'warning', status: 'open',
      detail: { old: { amount_native: 0.5, currency: 'USD' }, new: { amount_native: 0.55, currency: 'USD' } },
    });
    await div('COR.US', [d('2026-01-05', 0.6, { currency: 'EUR' })]);
    await replay({ all: true });
    f = await findings('CORPORATE_EVENT_CHANGED');
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toEqual({ old: { amount_native: 0.5, currency: 'USD' }, new: { amount_native: 0.6, currency: 'EUR' } });
  });

  test('DIVIDEND_SAME_EX_DATE: dos filas con la misma fecha ex no se escriben y el finding apunta al raw_payload; el resto sí', async () => {
    await makeListing('SAM.US');
    const id = await div('SAM.US', [d('2026-01-05', 0.5), d('2026-04-06', 0.4, { period: 'Quarterly' }), d('2026-04-06', 1.0, { period: 'Other' })]);
    const out = await replay();
    expect(out.dividends).toMatchObject({ inserted: 1, skippedSameExDate: 2 });
    expect(await dividends()).toEqual([expect.objectContaining({ ex_date: '2026-01-05' })]);
    const f = await findings('DIVIDEND_SAME_EX_DATE');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'raw_payload', target_key: { raw_payload_id: Number(id) }, severity: 'warning', status: 'open' });
    expect(f[0]!.detail).toMatchObject({ provider_symbol: 'SAM.US', dates: [{ ex_date: '2026-04-06' }] });
    expect(f[0]!.detail.dates[0].rows).toHaveLength(2);
    await replay({ all: true });
    expect(await findings('DIVIDEND_SAME_EX_DATE')).toHaveLength(1); // no se duplica
  });

  test('filas sin unadjustedValue, sin divisa o con fecha inválida se descartan contando; el ajustado solo no basta', async () => {
    await makeListing('BAD.US');
    await div('BAD.US', [d('2026-01-05', null), d('2026-02-05', 0.5, { currency: null }), d('2026-03-05', 0.5, { currency: '' }), d('nope', 1), d('2026-05-05', 0.7)]);
    const out = await replay();
    expect(out.dividends).toMatchObject({ rows: 5, inserted: 1, skippedNoValue: 3, skippedBadDate: 1 });
    expect(await dividends()).toEqual([expect.objectContaining({ ex_date: '2026-05-05', amount: '0.7' })]);
  });

  test('sin listing el payload sigue pendiente y se escribe en el siguiente replay', async () => {
    const id = await div('LATE.US', [d('2026-01-05', 0.5)]);
    expect(await replay()).toMatchObject({ checked: 0, deferred: 1 });
    expect((await pool.query('SELECT parse_status FROM raw_payload WHERE raw_payload_id = $1', [id])).rows[0].parse_status).toBe('pending');
    await makeListing('LATE.US');
    expect(await replay()).toMatchObject({ checked: 1, ok: 1, deferred: 0 });
    expect(await dividends()).toHaveLength(1);
  });

  test('una respuesta que no es una lista marca error', async () => {
    await makeListing('OBJ.US');
    const id = await div('OBJ.US', { message: 'x' });
    expect(await replay()).toMatchObject({ checked: 1, error: 1 });
    expect((await pool.query('SELECT parse_error FROM raw_payload WHERE raw_payload_id = $1', [id])).rows[0].parse_error).toMatch(/lista/);
  });
});

describe('escritor de splits', () => {
  test('numerador y denominador como texto del proveedor, también un ratio que no es entero limpio', async () => {
    await makeListing('SPL.US');
    await splits('SPL.US', [
      { date: '1998-06-02', split: '2.000000/1.000000' },
      { date: '1999-01-05', split: '959692.000000/319897.000000' },
      { date: '2022-06-06', split: '20.000000/1.000000' },
    ]);
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
    expect(out.splits).toMatchObject({ rows: 3, inserted: 3, changed: 0 });
    expect(await splitRows()).toEqual([
      { ex_date: '1998-06-02', n: '2.000000', d: '1.000000' },
      { ex_date: '1999-01-05', n: '959692.000000', d: '319897.000000' },
      { ex_date: '2022-06-06', n: '20.000000', d: '1.000000' },
    ]);
  });

  test('idempotente; 4.000000/1.000000 frente a 4/1 no es un cambio', async () => {
    await makeListing('SPI.US');
    await splits('SPI.US', [{ date: '2020-08-31', split: '4.000000/1.000000' }]);
    await replay();
    await splits('SPI.US', [{ date: '2020-08-31', split: '4/1' }]);
    const again = await replay({ all: true });
    expect(again.splits).toMatchObject({ inserted: 0, unchanged: 1, changed: 0 });
    expect(await count('data_quality_finding')).toBe(0);
  });

  test('un ratio corregido se actualiza y emite CORPORATE_EVENT_CHANGED conservando el old del primero', async () => {
    await makeListing('SPC.US');
    await splits('SPC.US', [{ date: '2020-08-31', split: '4.000000/1.000000' }]);
    await replay();
    await splits('SPC.US', [{ date: '2020-08-31', split: '5.000000/1.000000' }]);
    await replay({ all: true });
    await splits('SPC.US', [{ date: '2020-08-31', split: '6.000000/1.000000' }]);
    await replay({ all: true });
    expect(await splitRows()).toEqual([{ ex_date: '2020-08-31', n: '6.000000', d: '1.000000' }]);
    const f = await findings('CORPORATE_EVENT_CHANGED');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'stock_split', status: 'open', detail: { old: { split_numerator: 4, split_denominator: 1 }, new: { split_numerator: 6, split_denominator: 1 } } });
  });

  test('misma fecha dos veces: iguales se colapsan, distintas no se escriben; ratios ilegibles se descartan', async () => {
    await makeListing('SPD.US');
    await splits('SPD.US', [
      { date: '2001-01-01', split: '2/1' }, { date: '2001-01-01', split: '2.000000/1.000000' },
      { date: '2002-02-02', split: '2/1' }, { date: '2002-02-02', split: '3/1' },
      { date: '2003-03-03', split: 'raro' }, { date: '2004-04-04', split: '0/1' }, { date: 'x', split: '2/1' },
    ]);
    const out = await replay();
    expect(out.splits).toMatchObject({ rows: 7, inserted: 1, skippedConflict: 2, skippedNoValue: 2, skippedBadDate: 1 });
    expect(await splitRows()).toEqual([{ ex_date: '2001-01-01', n: '2', d: '1' }]);
  });

  test('sin listing el payload sigue pendiente', async () => {
    await splits('NOLIST.US', [{ date: '2020-08-31', split: '2/1' }]);
    expect(await replay()).toMatchObject({ checked: 0, deferred: 1 });
    expect(await count('stock_split')).toBe(0);
  });
});
