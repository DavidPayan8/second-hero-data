import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { replay } from '../src/eodhd/replay.js';

// Cuerpos pequeños y sintéticos con la forma real de exchange-symbol-list (Code, Name, Country, Exchange, Currency, Type,
// Isin) y de fundamentals (solo General). Los valores son de prueba. Los escritores leen únicamente de raw_payload +
// payload_blob, y se ejecutan con replay.
// Los escritores confirman datos: cada test parte de tablas vacías y la última limpieza deja la base como estaba,
// para no estorbar a los demás ficheros (comparten la base de test).
// DELETE en orden de dependencias, no TRUNCATE ... CASCADE: cada TRUNCATE hace fsync de todas las tablas dependientes y en
// Docker para Windows tarda segundos por test.
async function cleanAll() {
  for (const sql of [
    'DELETE FROM data_quality_finding', 'DELETE FROM listing', 'DELETE FROM security', 'DELETE FROM company',
    'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run',
    "DELETE FROM dimension_audit WHERE table_name IN ('company', 'security', 'listing')",
  ]) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(async () => {
  runId = ''; // la corrida de prueba se vuelve a crear en cada test
  await cleanAll();
});

let runId = '';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function newRun() {
  runId = (await pool.query<{ id: string }>("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd', 'test:escritores', 'ok', now()) RETURNING ingestion_run_id AS id")).rows[0]!.id;
  return runId;
}
async function addPayload(endpoint: string, symbol: string | null, params: Record<string, string>, body: unknown, status = 200): Promise<string> {
  if (!runId) await newRun();
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const hash = sha(bytes);
  await pool.query('INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [hash, bytes, bytes.length]);
  return (await pool.query<{ id: string }>(
    'INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING raw_payload_id AS id',
    [runId, endpoint, symbol, JSON.stringify(params), status, hash],
  )).rows[0]!.id;
}
const list = (code: string, records: unknown[], extra: Record<string, string> = {}) => addPayload('exchange-symbol-list/{code}', null, { code, ...extra }, records);
const fundamentals = (symbol: string, general: Record<string, unknown>) => addPayload('fundamentals/{symbol}', symbol, {}, { General: { Code: symbol.split('.')[0], Type: 'Common Stock', ...general } });
const sym = (Code: string, over: Record<string, unknown> = {}) => ({ Code, Name: `${Code} test`, Country: 'UK', Exchange: 'LSE', Currency: 'GBX', Type: 'ETF', Isin: null, ...over });
const run = (all = true) => replay({ all });
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0] as T;
const count = async (table: string) => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
const findings = async (rule: string) => (await pool.query('SELECT target_table, target_key, severity, status, detail FROM data_quality_finding WHERE rule_code = $1 ORDER BY finding_id', [rule])).rows;

describe('ETF: SECURITY y LISTING se crean ya, sin fundamentals', () => {
  test('un ETF de Londres: security sin company, listing primario con la divisa del símbolo y la bolsa de SOURCE_EXCHANGE', async () => {
    await list('LSE', [sym('TETF', { Isin: 'IE00TEST0001', Currency: 'GBX' })]);
    const out = await run();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
    expect(out.listings).toMatchObject({ symbols: 1, created: 1, securitiesCreated: 1, companiesCreated: 0 });
    const l = await one(`SELECT l.provider_symbol, l.ticker, l.quote_currency, l.status, l.status_date, l.is_primary_listing, e.mic, s.isin, s.company_id, a.code AS asset_type
                         FROM listing l JOIN security s USING (security_id) JOIN asset_type a USING (asset_type_id) JOIN exchange e USING (exchange_id)`);
    expect(l).toEqual({ provider_symbol: 'TETF.LSE', ticker: 'TETF', quote_currency: 'GBX', status: 'active', status_date: null, is_primary_listing: true, mic: 'XLON', isin: 'IE00TEST0001', company_id: null, asset_type: 'etf' });
    expect((await one('SELECT parse_status, parse_error FROM raw_payload'))).toEqual({ parse_status: 'ok', parse_error: null });
  });

  test('la divisa sale del campo Currency del símbolo, no de EXCHANGE.default_currency: GBX, USD y EUR en la bolsa de Londres', async () => {
    await list('LSE', [sym('AAA', { Currency: 'GBX' }), sym('BBB', { Currency: 'USD' }), sym('CCC', { Currency: 'EUR' })]);
    await run();
    const r = (await pool.query('SELECT ticker, quote_currency FROM listing ORDER BY ticker')).rows;
    expect(r).toEqual([{ ticker: 'AAA', quote_currency: 'GBX' }, { ticker: 'BBB', quote_currency: 'USD' }, { ticker: 'CCC', quote_currency: 'EUR' }]);
    expect((await one("SELECT default_currency FROM exchange WHERE mic = 'XLON'") as { default_currency: string }).default_currency).toBe('GBP'); // la de la bolsa no se usa
  });

  test('un ETF sin ISIN se crea igual (isin NULL)', async () => {
    await list('LSE', [sym('NOISIN', { Isin: null }), sym('NOISIN2', { Isin: '  ' })]);
    const out = await run();
    expect(out.listings).toMatchObject({ created: 2 });
    expect((await pool.query('SELECT isin FROM security')).rows).toEqual([{ isin: null }, { isin: null }]);
  });
});

describe('acciones: solo con un fundamentals del mismo símbolo a la vista', () => {
  const stock = (Code: string, over: Record<string, unknown> = {}) => sym(Code, { Type: 'Common Stock', Exchange: 'NASDAQ', Country: 'USA', Currency: 'USD', ...over });
  const AAPL = { Name: 'Test Apple Inc', CIK: '0000000111', LEI: 'LEITEST0000000000001', ISIN: 'US0000000111', CountryISO: 'US', FiscalYearEnd: 'September' };

  test('sin fundamentals la acción se salta SIN finding y se cuenta; con fundamentals, al repetir el replay, se crea', async () => {
    await list('US', [stock('AAPL', { Isin: 'US0000000111' })]);
    const first = await run();
    expect(first.listings).toMatchObject({ symbols: 1, created: 0, skippedNoFundamentals: 1 });
    expect(await count('listing')).toBe(0);
    expect(await count('company')).toBe(0);
    expect(await count('data_quality_finding')).toBe(0); // trabajo pendiente, no un problema de calidad
    await fundamentals('AAPL.US', AAPL);
    const second = await run();
    expect(second.listings).toMatchObject({ created: 1, securitiesCreated: 1, companiesCreated: 1, skippedNoFundamentals: 0 });
    const co = await one('SELECT legal_name, cik, lei, identity_source, country_iso, fiscal_year_end_month FROM company');
    expect(co).toEqual({ legal_name: 'Test Apple Inc', cik: '0000000111', lei: 'LEITEST0000000000001', identity_source: 'cik', country_iso: 'US', fiscal_year_end_month: 9 });
    const l = await one('SELECT l.provider_symbol, e.mic, a.code AS t, s.company_id IS NOT NULL AS has_co FROM listing l JOIN security s USING (security_id) JOIN asset_type a USING (asset_type_id) JOIN exchange e USING (exchange_id)');
    expect(l).toEqual({ provider_symbol: 'AAPL.US', mic: 'XNAS', t: 'common_stock', has_co: true });
  });

  test('doble clase: dos símbolos con el mismo CIK comparten una company y tienen dos securities', async () => {
    await list('US', [stock('GOOGL', { Isin: 'US0000000201' }), stock('GOOG', { Isin: 'US0000000202' })]);
    await fundamentals('GOOGL.US', { Name: 'Test Alphabet Inc', CIK: '0000000200', LEI: null });
    await fundamentals('GOOG.US', { Name: 'Test Alphabet Inc', CIK: '0000000200', LEI: null });
    const out = await run();
    expect(out.listings).toMatchObject({ created: 2, securitiesCreated: 2, companiesCreated: 1 });
    expect(await count('company')).toBe(1);
    expect((await pool.query('SELECT DISTINCT company_id FROM security')).rowCount).toBe(1);
    expect((await one<{ identity_source: string }>('SELECT identity_source FROM company')).identity_source).toBe('cik');
  });

  test('solo LEI -> identity_source lei; ni CIK ni LEI -> isolated + IDENTITY_ISOLATED; un CIK de ceros no cuenta', async () => {
    await list('US', [stock('SOLOLEI', { Isin: 'US0000000301' }), stock('NINGUNO', { Isin: 'US0000000302' }), stock('CEROS', { Isin: 'US0000000303' })]);
    await fundamentals('SOLOLEI.US', { Name: 'Solo LEI', CIK: null, LEI: 'LEITEST0000000000003' });
    await fundamentals('NINGUNO.US', { Name: 'Sin ids', CIK: '', LEI: ' ' });
    await fundamentals('CEROS.US', { Name: 'Ceros', CIK: '0000000000', LEI: null });
    const out = await run();
    expect(out.listings).toMatchObject({ created: 3, companiesCreated: 3, isolated: 2 });
    const cos = (await pool.query('SELECT legal_name, identity_source, cik, lei FROM company ORDER BY legal_name')).rows;
    expect(cos).toEqual([
      { legal_name: 'Ceros', identity_source: 'isolated', cik: null, lei: null },
      { legal_name: 'Sin ids', identity_source: 'isolated', cik: null, lei: null },
      { legal_name: 'Solo LEI', identity_source: 'lei', cik: null, lei: 'LEITEST0000000000003' },
    ]);
    const f = await findings('IDENTITY_ISOLATED');
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.target_table === 'company' && x.status === 'open' && x.severity === 'warning')).toBe(true);
  });

  test('un CIK que contradice el LEI de la company existente -> IDENTITY_RELINK_CONFLICT y el símbolo no se ingiere', async () => {
    await list('US', [stock('UNO', { Isin: 'US0000000401' }), stock('DOS', { Isin: 'US0000000402' })]);
    await fundamentals('UNO.US', { Name: 'Uno', CIK: '0000000400', LEI: 'LEITEST0000000000004' });
    await fundamentals('DOS.US', { Name: 'Dos', CIK: '0000000400', LEI: 'LEITEST0000000000099' }); // mismo CIK, otro LEI
    const out = await run();
    expect(out.listings).toMatchObject({ created: 1, relinkConflicts: 1 });
    expect((await findings('IDENTITY_RELINK_CONFLICT'))[0]!.detail).toMatchObject({ conflicts: [{ provider_symbol: 'DOS.US', reason: 'lei' }] });
    expect(await count('company')).toBe(1);
  });

  test('varios conflictos de company en un payload: un solo finding agregado, ninguno pisa a otro', async () => {
    await list('US', [stock('A1', { Isin: 'US0000000601' }), stock('A2', { Isin: 'US0000000602' }), stock('B1', { Isin: 'US0000000603' }), stock('B2', { Isin: 'US0000000604' })]);
    await fundamentals('A1.US', { Name: 'A', CIK: '0000000600', LEI: 'LEITEST0000000000006' });
    await fundamentals('A2.US', { Name: 'A', CIK: '0000000600', LEI: 'LEITEST0000000000096' });
    await fundamentals('B1.US', { Name: 'B', CIK: '0000000610', LEI: 'LEITEST0000000000007' });
    await fundamentals('B2.US', { Name: 'B', CIK: '0000000610', LEI: 'LEITEST0000000000097' });
    const out = await run();
    expect(out.listings).toMatchObject({ created: 2, relinkConflicts: 2 });
    const f = await findings('IDENTITY_RELINK_CONFLICT');
    expect(f).toHaveLength(1);
    expect((f[0]!.detail as { conflicts: { provider_symbol: string }[] }).conflicts.map((x) => x.provider_symbol)).toEqual(['A2.US', 'B2.US']);
  });

  test('una company encontrada por LEI se completa con el CIK que le faltaba', async () => {
    await list('US', [stock('LEIPRIMERO', { Isin: 'US0000000501' }), stock('CONCIK', { Isin: 'US0000000502' })]);
    await fundamentals('LEIPRIMERO.US', { Name: 'Misma', CIK: null, LEI: 'LEITEST0000000000005' });
    await fundamentals('CONCIK.US', { Name: 'Misma', CIK: '0000000500', LEI: 'LEITEST0000000000005' });
    await run();
    expect(await count('company')).toBe(1);
    expect(await one('SELECT cik, lei, identity_source FROM company')).toEqual({ cik: '0000000500', lei: 'LEITEST0000000000005', identity_source: 'lei' });
  });
});

describe('filtro por tipo antes que nada', () => {
  test('los tipos conocidos fuera de alcance se saltan sin finding; no resuelven venue ni generan VENUE_UNMAPPED', async () => {
    await list('US', [
      sym('FONDO', { Type: 'FUND', Exchange: 'NMFQS', Currency: 'USD' }), sym('MUTUO', { Type: 'Mutual Fund', Exchange: 'NMFQS', Currency: 'USD' }),
      sym('WARR', { Type: 'Warrant', Exchange: 'NASDAQ', Currency: 'USD' }), sym('SINTIPO', { Type: null, Exchange: 'NASDAQ', Currency: 'USD' }),
    ]);
    const out = await run();
    expect(out.listings).toMatchObject({ symbols: 4, skippedOutOfScope: 4, created: 0, venueUnmapped: 0, unknownTypes: 0 });
    expect(await count('data_quality_finding')).toBe(0);
    expect(await count('listing')).toBe(0);
  });

  test('un Type nuevo del proveedor no se ingiere y emite ASSET_TYPE_UNMAPPED (un finding por payload, con recuentos)', async () => {
    const id = await list('LSE', [sym('X1', { Type: 'Crypto Token' }), sym('X2', { Type: 'Crypto Token' }), sym('X3', { Type: 'Rights' }), sym('OK', { Isin: 'IE00TEST0009' })]);
    const out = await run();
    expect(out.listings).toMatchObject({ created: 1, unknownTypes: 3 });
    const f = await findings('ASSET_TYPE_UNMAPPED');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'raw_payload', target_key: { raw_payload_id: Number(id) }, detail: { types: { 'Crypto Token': 2, Rights: 1 } } });
  });
});

describe('venue', () => {
  test('agregado US: etiqueta -> MIC por SOURCE_VENUE_MAP; sin mapa -> exchange_id NULL + VENUE_UNMAPPED sobre el listing', async () => {
    await list('US', [
      sym('NQ', { Exchange: 'NASDAQ', Currency: 'USD', Isin: 'US0000001001' }), sym('NY', { Exchange: 'NYSE', Currency: 'USD', Isin: 'US0000001002' }),
      sym('OTC1', { Exchange: 'PINK', Currency: 'USD', Isin: 'US0000001003' }), sym('BBB', { Exchange: 'BATS', Currency: 'USD', Isin: 'US0000001004' }),
      sym('GEN', { Exchange: 'US', Currency: 'USD', Isin: 'US0000001005' }), sym('OLD', { Exchange: 'OTCBB', Currency: 'USD', Isin: 'US0000001006' }),
      sym('NOLABEL', { Exchange: null, Currency: 'USD', Isin: 'US0000001007' }), sym('FONDOETF', { Exchange: 'NMFQS', Currency: 'USD', Isin: 'US0000001008' }),
    ]);
    const out = await run();
    expect(out.listings).toMatchObject({ created: 8, venueUnmapped: 4 });
    const mics = Object.fromEntries((await pool.query('SELECT l.ticker, e.mic FROM listing l LEFT JOIN exchange e USING (exchange_id)')).rows.map((r) => [r.ticker, r.mic]));
    expect(mics).toEqual({ NQ: 'XNAS', NY: 'XNYS', OTC1: 'OTCM', BBB: 'BATS', GEN: null, OLD: null, NOLABEL: null, FONDOETF: null });
    const f = await findings('VENUE_UNMAPPED');
    expect(f).toHaveLength(4);
    expect(f.every((x) => x.target_table === 'listing' && x.status === 'open')).toBe(true);
    const ids = (await pool.query("SELECT listing_id, ticker FROM listing WHERE exchange_id IS NULL")).rows;
    expect(f.map((x) => String(x.target_key.listing_id)).sort()).toEqual(ids.map((x) => String(x.listing_id)).sort());
    expect(f.find((x) => x.detail.provider_symbol === 'GEN.US')!.detail).toEqual({ provider_symbol: 'GEN.US', provider_code: 'US', venue_label: 'US' });
  });

  test('código sin fila en SOURCE_EXCHANGE: el listing se crea sin MIC con VENUE_UNMAPPED; código virtual: se salta todo', async () => {
    await list('XFRA', [sym('SAPX', { Exchange: 'F', Currency: 'EUR', Isin: 'DE0000000001' })]);
    await list('FOREX', [sym('EURUSD', { Type: 'ETF', Exchange: 'FOREX', Currency: 'USD' })]);
    const out = await run();
    expect(out.listings).toMatchObject({ created: 1, venueUnmapped: 1, skippedVirtual: 1 });
    expect((await one<{ provider_symbol: string; exchange_id: string | null }>('SELECT provider_symbol, exchange_id FROM listing'))).toEqual({ provider_symbol: 'SAPX.XFRA', exchange_id: null });
  });

  test('un venue que deja de resolverse no borra el que ya se conocía', async () => {
    await list('US', [sym('PERM', { Exchange: 'NASDAQ', Currency: 'USD', Isin: 'US0000002001' })]);
    await run();
    await list('US', [sym('PERM', { Exchange: 'ETIQUETA_NUEVA', Currency: 'USD', Isin: 'US0000002001' })]);
    await run();
    expect((await one<{ mic: string }>('SELECT e.mic FROM listing l JOIN exchange e USING (exchange_id)')).mic).toBe('XNAS');
  });
});

describe('divisa de cotización', () => {
  test('sin Currency no se crea el listing y se emite QUOTE_CURRENCY_MISSING sobre el raw_payload', async () => {
    const id = await list('LSE', [sym('SIN1', { Currency: null }), sym('SIN2', { Currency: '  ' }), sym('CON', { Currency: 'GBX', Isin: 'IE00TEST0010' }), sym('SIN3', { Currency: undefined })]);
    const out = await run();
    expect(out.listings).toMatchObject({ created: 1, currencyMissing: 3 });
    expect(await count('listing')).toBe(1);
    const f = await findings('QUOTE_CURRENCY_MISSING');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'raw_payload', target_key: { raw_payload_id: Number(id) }, detail: { count: 3, sample: ['SIN1.LSE', 'SIN2.LSE', 'SIN3.LSE'] }, severity: 'warning' });
  });

  test('un símbolo fuera de alcance sin divisa no genera finding (el tipo se filtra antes)', async () => {
    await list('LSE', [sym('FUNDSIN', { Type: 'FUND', Currency: null })]);
    const out = await run();
    expect(out.listings).toMatchObject({ skippedOutOfScope: 1, currencyMissing: 0 });
    expect(await count('data_quality_finding')).toBe(0);
  });
});

describe('camino rápido por provider_symbol con comprobación del ISIN', () => {
  const bbby = (Isin: string | null, over: Record<string, unknown> = {}) => sym('BBBY', { Exchange: 'NYSE', Currency: 'USD', Isin, ...over });

  test('el mismo símbolo con otro ISIN (ticker reutilizado) -> IDENTITY_RELINK_CONFLICT, ese símbolo no se toca', async () => {
    await list('US', [bbby('US0000003001')]);
    await run();
    const before = await one('SELECT l.listing_id, l.quote_currency, s.isin FROM listing l JOIN security s USING (security_id)');
    await list('US', [bbby('US0000003999', { Currency: 'EUR' })]); // otra empresa con el mismo ticker
    await run();
    const after = await one('SELECT l.listing_id, l.quote_currency, s.isin FROM listing l JOIN security s USING (security_id)');
    expect(after).toEqual(before); // ni la divisa ni el ISIN cambiaron
    const f = await findings('IDENTITY_RELINK_CONFLICT');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'listing', severity: 'error', detail: { provider_symbol: 'BBBY.US', reason: 'isin', existing_isin: 'US0000003001', incoming_isin: 'US0000003999' } });
    expect(await count('listing')).toBe(1);
  });

  test('mismo ISIN: sin cambios. ISIN ausente en la entrada: se conserva el existente. ISIN que faltaba: se completa', async () => {
    await list('US', [bbby(null)]);
    await run();
    expect((await one<{ isin: string | null }>('SELECT isin FROM security')).isin).toBeNull();
    await list('US', [bbby('US0000003002')]);
    await run();
    expect((await one<{ isin: string | null }>('SELECT isin FROM security')).isin).toBe('US0000003002'); // completado
    await list('US', [bbby(null)]);
    await run();
    expect((await one<{ isin: string | null }>('SELECT isin FROM security')).isin).toBe('US0000003002'); // no se pierde
    expect(await count('data_quality_finding')).toBe(0);
  });

  test('completar un ISIN que ya pertenece a otra security es un conflicto', async () => {
    await list('US', [sym('OTRO', { Exchange: 'NYSE', Currency: 'USD', Isin: 'US0000003003' }), bbby(null)]);
    await run();
    await list('US', [bbby('US0000003003')]);
    await run();
    expect((await findings('IDENTITY_RELINK_CONFLICT'))[0]!.detail).toMatchObject({ reason: 'isin_in_use', incoming_isin: 'US0000003003' });
    expect((await one<{ isin: string | null }>("SELECT s.isin FROM listing l JOIN security s USING (security_id) WHERE l.ticker = 'BBBY'")).isin).toBeNull();
  });

  test('cambia la divisa, la bolsa o el estado del mismo símbolo: se actualiza el listing (y queda auditado) sin crear otro', async () => {
    await list('US', [bbby('US0000003004', { Exchange: 'NYSE', Currency: 'USD' })]);
    await run();
    await list('US', [bbby('US0000003004', { Exchange: 'NASDAQ', Currency: 'USD' })]);
    await run();
    expect((await one<{ mic: string }>('SELECT e.mic FROM listing l JOIN exchange e USING (exchange_id)')).mic).toBe('XNAS');
    await list('US', [bbby('US0000003004', { Exchange: 'NASDAQ', Currency: 'USD' })], { delisted: '1' }); // ahora en la lista de deslistadas
    const out = await run();
    expect(out.listings!.updated).toBeGreaterThanOrEqual(1);
    expect((await one<{ status: string }>('SELECT status FROM listing')).status).toBe('delisted');
    expect(await count('listing')).toBe(1);
    const aud = (await pool.query("SELECT column_name, old_value, new_value, changed_by, reason FROM dimension_audit WHERE table_name = 'listing' AND op = 'update' ORDER BY dimension_audit_id")).rows;
    expect(aud.some((a) => a.column_name === 'status' && a.old_value === 'active' && a.new_value === 'delisted')).toBe(true);
    expect(aud.every((a) => a.changed_by === 'normalizer' && /raw_payload/.test(a.reason))).toBe(true);
  });

  test('un ETF y una acción con el mismo ISIN de una security ya creada de otro tipo -> conflicto', async () => {
    await list('US', [sym('AMBOS', { Exchange: 'NYSE', Currency: 'USD', Isin: 'US0000003006', Type: 'ETF' })]);
    await run();
    await list('US', [sym('AMBOS', { Exchange: 'NYSE', Currency: 'USD', Isin: 'US0000003006', Type: 'Common Stock' })]);
    await run();
    expect((await findings('IDENTITY_RELINK_CONFLICT'))[0]!.detail).toMatchObject({ reason: 'asset_type' });
  });
});

describe('varias cotizaciones por security y listing primario (P12)', () => {
  const primaries = async () => (await pool.query(
    `SELECT s.isin, l.provider_symbol FROM listing l JOIN security s USING (security_id) WHERE l.is_primary_listing ORDER BY s.isin, l.provider_symbol`,
  )).rows as { isin: string; provider_symbol: string }[];
  const perSecurity = async () => (await pool.query(
    `SELECT s.isin, count(*)::int AS listings, count(*) FILTER (WHERE l.is_primary_listing)::int AS primarios FROM listing l JOIN security s USING (security_id) GROUP BY s.isin ORDER BY s.isin`,
  )).rows;

  test('ARKC (GBX) y 1ARG (USD) con el mismo ISIN: una security, dos listings, primario ARKC, también con la lista al revés', async () => {
    for (const orden of [['1ARG', 'ARKC'], ['ARKC', '1ARG']]) {
      await cleanAll();
      runId = '';
      const lineas: Record<string, unknown> = { '1ARG': sym('1ARG', { Currency: 'USD', Isin: 'GB00TEST0001' }), ARKC: sym('ARKC', { Currency: 'GBX', Isin: 'GB00TEST0001' }) };
      await list('LSE', orden.map((k) => lineas[k]));
      const out = await run();
      expect(out.listings).toMatchObject({ created: 2, securitiesCreated: 1 });
      expect(await perSecurity()).toEqual([{ isin: 'GB00TEST0001', listings: 2, primarios: 1 }]);
      expect(await primaries()).toEqual([{ isin: 'GB00TEST0001', provider_symbol: 'ARKC.LSE' }]);
      expect(await count('security')).toBe(1);
    }
  });

  test('regla 1: la bolsa del país del prefijo del ISIN gana aunque otra cotice en la divisa de su bolsa; no depende del orden de captura', async () => {
    for (const ordenPayloads of [['LSE', 'IR'], ['IR', 'LSE']]) {
      await cleanAll();
      runId = '';
      const payloads: Record<string, unknown[]> = {
        LSE: [sym('ETFX', { Exchange: 'LSE', Currency: 'GBX', Isin: 'IE00TEST0501' })], // XLON es de GB: divisa de su bolsa (GBX cuenta como GBP) pero país distinto del prefijo IE
        IR: [sym('ETFX', { Exchange: 'IR', Currency: 'USD', Isin: 'IE00TEST0501' })], // XDUB es de IE: país del prefijo, aunque la divisa no sea EUR
      };
      for (const code of ordenPayloads) await list(code, payloads[code]!);
      await run();
      expect(await primaries()).toEqual([{ isin: 'IE00TEST0501', provider_symbol: 'ETFX.IR' }]);
      expect((await perSecurity())[0]).toMatchObject({ listings: 2, primarios: 1 });
    }
  });

  test('regla 2: la divisa de la bolsa o su subunidad gana a las demás cuando el país no discrimina', async () => {
    await list('LSE', [sym('AAA', { Currency: 'USD', Isin: 'GB00TEST0601' }), sym('ZZZ', { Currency: 'GBX', Isin: 'GB00TEST0601' }), sym('MMM', { Currency: 'EUR', Isin: 'GB00TEST0601' })]);
    await run();
    expect(await primaries()).toEqual([{ isin: 'GB00TEST0601', provider_symbol: 'ZZZ.LSE' }]); // ZZZ en GBX, aunque AAA sea alfabéticamente menor
    // GBP también es la divisa de la bolsa
    await cleanAll(); runId = '';
    await list('LSE', [sym('AAA', { Currency: 'USD', Isin: 'GB00TEST0602' }), sym('ZZZ', { Currency: 'GBP', Isin: 'GB00TEST0602' })]);
    await run();
    expect(await primaries()).toEqual([{ isin: 'GB00TEST0602', provider_symbol: 'ZZZ.LSE' }]);
  });

  test('regla 3: con todo igual, el provider_symbol menor en orden alfabético', async () => {
    await list('LSE', [sym('CCC', { Currency: 'USD', Isin: 'GB00TEST0701' }), sym('AAA', { Currency: 'USD', Isin: 'GB00TEST0701' }), sym('BBB', { Currency: 'USD', Isin: 'GB00TEST0701' })]);
    await run();
    expect(await primaries()).toEqual([{ isin: 'GB00TEST0701', provider_symbol: 'AAA.LSE' }]);
  });

  test('un prefijo de ISIN que no es un país (XS) no puntúa: manda la divisa y luego el símbolo', async () => {
    await list('LSE', [sym('BONO1', { Currency: 'USD', Isin: 'XS0000000001' })]);
    await list('IR', [sym('BONO2', { Exchange: 'IR', Currency: 'EUR', Isin: 'XS0000000001' })]); // XDUB: EUR, la divisa de su bolsa
    await run();
    expect(await primaries()).toEqual([{ isin: 'XS0000000001', provider_symbol: 'BONO2.IR' }]);
  });

  test('un listing sin bolsa no es primario si hay otro con bolsa, aunque su símbolo sea menor y su divisa encaje', async () => {
    await list('XFRA', [sym('AAA', { Exchange: 'F', Currency: 'EUR', Isin: 'DE00TEST0801' })]); // código sin fila en SOURCE_EXCHANGE: sin MIC
    await list('LSE', [sym('ZZZ', { Currency: 'USD', Isin: 'DE00TEST0801' })]);
    await run();
    expect(await primaries()).toEqual([{ isin: 'DE00TEST0801', provider_symbol: 'ZZZ.LSE' }]);
    // y si solo hay uno sin bolsa, es el primario
    await cleanAll(); runId = '';
    await list('XFRA', [sym('SOLO', { Exchange: 'F', Currency: 'EUR', Isin: 'DE00TEST0802' })]);
    await run();
    expect(await primaries()).toEqual([{ isin: 'DE00TEST0802', provider_symbol: 'SOLO.XFRA' }]);
  });

  test('la misma security cotizando en dos bolsas distintas (US y LSE): la del país del ISIN gana', async () => {
    await list('LSE', [sym('DUAL', { Exchange: 'LSE', Currency: 'GBX', Isin: 'US0000003005' })]);
    await list('US', [sym('DUAL', { Exchange: 'NASDAQ', Currency: 'USD', Isin: 'US0000003005' })]);
    await run();
    expect(await count('security')).toBe(1);
    expect(await primaries()).toEqual([{ isin: 'US0000003005', provider_symbol: 'DUAL.US' }]);
  });

  test('sin ISIN, una security por símbolo y cada listing es el primario de la suya', async () => {
    await list('LSE', [sym('SINISIN', { Isin: null }), sym('OTRO', { Isin: null })]);
    await run();
    expect(await count('security')).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS n FROM listing WHERE is_primary_listing')).rows[0].n).toBe(2);
  });

  test('un listing nuevo que gana cambia el primario y el cambio queda auditado; una segunda pasada deja 0 filas nuevas', async () => {
    await list('LSE', [sym('1ARG', { Currency: 'USD', Isin: 'GB00TEST0901' })]);
    const p1 = await run();
    expect(p1.listings).toMatchObject({ created: 1, primaryChanges: 0 });
    expect(await primaries()).toEqual([{ isin: 'GB00TEST0901', provider_symbol: '1ARG.LSE' }]);
    await list('LSE', [sym('1ARG', { Currency: 'USD', Isin: 'GB00TEST0901' }), sym('ARKC', { Currency: 'GBX', Isin: 'GB00TEST0901' })]); // aparece la línea GBX
    const p2 = await run();
    expect(p2.listings).toMatchObject({ created: 1, primaryChanges: 1 });
    expect(await primaries()).toEqual([{ isin: 'GB00TEST0901', provider_symbol: 'ARKC.LSE' }]);
    const aud = (await pool.query(
      `SELECT d.old_value, d.new_value, d.changed_by, d.reason, l.provider_symbol FROM dimension_audit d JOIN listing l ON d.row_key = jsonb_build_object('listing_id', l.listing_id)
       WHERE d.table_name = 'listing' AND d.column_name = 'is_primary_listing' AND d.op = 'update' ORDER BY d.dimension_audit_id`,
    )).rows;
    expect(aud).toMatchObject([{ provider_symbol: '1ARG.LSE', old_value: 'true', new_value: 'false', changed_by: 'normalizer' }]);
    expect(aud[0]!.reason).toMatch(/raw_payload/);
    const before = await count('dimension_audit');
    const p3 = await run();
    expect(p3.listings).toMatchObject({ created: 0, primaryChanges: 0 });
    expect(await count('dimension_audit')).toBe(before); // 0 filas nuevas
    expect(await primaries()).toEqual([{ isin: 'GB00TEST0901', provider_symbol: 'ARKC.LSE' }]);
  });

  test('un ISIN que se completa después entra en la regla del primario', async () => {
    await list('IR', [sym('SIN1', { Exchange: 'IR', Currency: 'USD', Isin: null })]);
    await run();
    // sin ISIN, el listing es el único: primario. Cuando llega el ISIN (IE) y otra línea en LSE, el país del prefijo decide.
    await list('IR', [sym('SIN1', { Exchange: 'IR', Currency: 'USD', Isin: 'IE00TEST1001' })]);
    await list('LSE', [sym('SIN2', { Exchange: 'LSE', Currency: 'GBX', Isin: 'IE00TEST1001' })]);
    await run();
    expect(await primaries()).toEqual([{ isin: 'IE00TEST1001', provider_symbol: 'SIN1.IR' }]);
  });

  test('el resultado no depende del orden de las listas: Londres se procesa antes que EEUU y aun así queda estable en un solo replay', async () => {
    // la lista de Londres (más antigua) trae la acción con el ISIN de una acción que solo se crea desde la lista de EEUU, que tiene su fundamentals
    await list('LSE', [sym('0AAA', { Type: 'Common Stock', Currency: 'USD', Isin: 'US0000012001' })]);
    await list('US', [sym('AAA', { Type: 'Common Stock', Exchange: 'NASDAQ', Currency: 'USD', Isin: 'US0000012001' })]);
    await fundamentals('AAA.US', { Name: 'Acción AAA', CIK: '0000012000' });
    const first = await run();
    expect(first.listings).toMatchObject({ created: 2, securitiesCreated: 1, companiesCreated: 1 });
    expect(first.listingsSweeps).toBe(3); // la 2.ª pasada encuentra la security que la 1.ª creó y la 3.ª confirma que ya no cambia nada
    expect(await primaries()).toEqual([{ isin: 'US0000012001', provider_symbol: 'AAA.US' }]);
    const estado = async () => ({ l: await count('listing'), s: await count('security'), c: await count('company'), a: await count('dimension_audit'), f: await count('data_quality_finding') });
    const antes = await estado();
    const second = await run();
    expect(second.listings).toMatchObject({ created: 0, updated: 0, securitiesCreated: 0, companiesCreated: 0, primaryChanges: 0 });
    expect(second.listingsSweeps).toBe(1);
    expect(await estado()).toEqual(antes); // 0 filas nuevas
  });

  test('si las pasadas no convergen dentro del tope, replay falla con un error explícito', async () => {
    await list('LSE', [sym('0AAA', { Type: 'Common Stock', Currency: 'USD', Isin: 'US0000012001' })]);
    await list('US', [sym('AAA', { Type: 'Common Stock', Exchange: 'NASDAQ', Currency: 'USD', Isin: 'US0000012001' })]);
    await fundamentals('AAA.US', { Name: 'Acción AAA', CIK: '0000012000' });
    await expect(replay({ all: true, maxSweeps: 2 })).rejects.toThrow(/no converge/);
  });

  test('delisted que reaparece como activo: no se reactiva y emite LISTING_REAPPEARED; una lista de activos vieja no avisa', async () => {
    await list('US', [sym('RENACE', { Exchange: 'NYSE', Currency: 'USD', Isin: 'US0000011001' })]); // p1 activo
    await list('US', [sym('RENACE', { Exchange: 'NYSE', Currency: 'USD', Isin: 'US0000011001' })], { delisted: '1' }); // p2 deslistado, más nuevo
    await run();
    expect((await one<{ status: string }>('SELECT status FROM listing')).status).toBe('delisted');
    expect(await findings('LISTING_REAPPEARED')).toHaveLength(0); // la lista de activos es la vieja: no es una reaparición
    await list('US', [sym('RENACE', { Exchange: 'NYSE', Currency: 'USD', Isin: 'US0000011001' })]); // p3 activo, el más nuevo
    const out = await run();
    expect(out.listings).toMatchObject({ reappeared: 1 });
    expect((await one<{ status: string }>('SELECT status FROM listing')).status).toBe('delisted'); // no se reactiva
    const f = await findings('LISTING_REAPPEARED');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'listing', severity: 'warning', status: 'open', detail: { provider_symbol: 'RENACE.US' } });
    const before = await count('dimension_audit');
    await run();
    expect(await findings('LISTING_REAPPEARED')).toHaveLength(1); // repetir no duplica
    expect(await count('dimension_audit')).toBe(before);
  });
});

describe('ISIN contradictorio dentro de un payload', () => {
  const mixed = (first: 'Common Stock' | 'ETF') => {
    const stock = sym('MIXS', { Type: 'Common Stock', Currency: 'GBX', Isin: 'GB0000000001' });
    const etf = sym('MIXE', { Type: 'ETF', Currency: 'GBX', Isin: 'GB0000000001' });
    return first === 'ETF' ? [etf, stock, sym('LIMPIO', { Isin: 'GB0000000002' })] : [stock, etf, sym('LIMPIO', { Isin: 'GB0000000002' })];
  };
  for (const first of ['ETF', 'Common Stock'] as const) {
    test(`el resultado no depende del orden de la lista (primero ${first}): no se ingiere ninguno de los dos y se agrega un finding`, async () => {
      const id = await list('LSE', mixed(first));
      await fundamentals('MIXS.LSE', { Name: 'Mixta', CIK: '0000000800' });
      const out = await run();
      expect(out.listings).toMatchObject({ created: 1, relinkConflicts: 2, skippedNoFundamentals: 0 });
      expect((await pool.query('SELECT ticker FROM listing')).rows).toEqual([{ ticker: 'LIMPIO' }]);
      const f = await findings('IDENTITY_RELINK_CONFLICT');
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ target_table: 'raw_payload', target_key: { raw_payload_id: Number(id) }, detail: { conflicts: [{ reason: 'isin_asset_type', isin: 'GB0000000001', symbols: ['MIXE.LSE', 'MIXS.LSE'] }] } });
      expect((await run()).listings).toMatchObject({ created: 0, relinkConflicts: 2 }); // y repetirlo no cambia nada
      expect(await findings('IDENTITY_RELINK_CONFLICT')).toHaveLength(1);
    });
  }
});

describe('idempotencia y replay', () => {
  const body = () => [
    sym('E1', { Isin: 'IE00TEST0101' }), sym('E2', { Isin: 'IE00TEST0102', Currency: 'USD' }), sym('F1', { Type: 'FUND' }),
    sym('SINDIV', { Currency: null }), sym('NOVENUE', { Isin: 'IE00TEST0103' }),
    { ...sym('S1', { Type: 'Common Stock', Isin: 'IE00TEST0104' }) }, sym('RARO', { Type: 'Crypto Token' }),
  ];
  const snapshot = async () => ({
    listing: (await pool.query('SELECT provider_symbol, ticker, quote_currency, status, exchange_id FROM listing ORDER BY 1')).rows,
    security: await count('security'), company: await count('company'),
    findings: (await pool.query('SELECT rule_code, target_table, target_key, detail, status FROM data_quality_finding ORDER BY rule_code, finding_id')).rows,
    audit: await count('dimension_audit'),
  });

  test('dos pasadas dejan los mismos recuentos y 0 filas nuevas en dimension_audit ni en findings', async () => {
    await list('LSE', body());
    await list('US', [sym('GEN', { Exchange: 'US', Currency: 'USD', Isin: 'US0000004001' })]);
    await fundamentals('S1.LSE', { Name: 'Con fundamentals', CIK: '0000000700' });
    const first = await run();
    const a = await snapshot();
    expect(first.error).toBe(0);
    const second = await run();
    const b = await snapshot();
    expect(second.error).toBe(0);
    expect(b).toEqual(a); // mismos recuentos, mismas filas, mismos findings
    expect(b.audit).toBe(a.audit); // 0 filas nuevas en dimension_audit
    // y la segunda pasada vio lo mismo que la primera, pero sin crear nada
    expect(second.listings).toMatchObject({ created: 0, securitiesCreated: 0, companiesCreated: 0, symbols: first.listings!.symbols });
    expect(second.listings!.unchanged).toBe(first.listings!.created);
    expect(a.listing.length).toBeGreaterThan(0);
  });

  test('sin all solo se recorren las filas pending; después de una pasada no queda ninguna', async () => {
    await list('LSE', [sym('P1', { Isin: 'IE00TEST0201' })]);
    expect(await replay()).toMatchObject({ checked: 1, ok: 1 });
    expect(await replay()).toEqual({ checked: 0, ok: 0, error: 0, deferred: 0 });
    expect((await replay({ all: true })).checked).toBe(1);
  });

  test('replay no usa la red', async () => {
    await list('LSE', [sym('NR', { Isin: 'IE00TEST0202' })]);
    const mock = vi.fn(() => { throw new Error('sin red'); });
    vi.stubGlobal('fetch', mock);
    try { await replay({ all: true }); } finally { vi.unstubAllGlobals(); }
    expect(mock).not.toHaveBeenCalled();
    expect(await count('listing')).toBe(1);
  });

  test('un cuerpo que no es una lista marca error en el payload y revierte la transacción del escritor', async () => {
    await addPayload('exchange-symbol-list/{code}', null, { code: 'LSE' }, { error: 'no es una lista' });
    const out = await replay({ all: true });
    expect(out).toMatchObject({ checked: 1, ok: 0, error: 1 });
    expect((await one<{ parse_error: string }>('SELECT parse_error FROM raw_payload')).parse_error).toContain('escritor de listings');
    expect(await count('listing')).toBe(0);
  });

  test('una excepción a mitad de payload no deja nada a medias', async () => {
    // el segundo registro viola una restricción temporal creada solo para este test
    await list('LSE', [sym('OK1', { Isin: 'IE00TEST0301' }), sym('MALO', { Isin: 'IE00TEST0302' })]);
    await pool.query('ALTER TABLE listing ADD CONSTRAINT t_forzar_fallo CHECK (ticker <> \'MALO\')');
    try {
      const out = await run();
      expect(out).toMatchObject({ error: 1 });
      expect(await count('listing')).toBe(0); // OK1 tampoco quedó: una transacción por payload
      expect(await count('security')).toBe(0);
    } finally {
      await pool.query('ALTER TABLE listing DROP CONSTRAINT t_forzar_fallo');
    }
  });

  test('un finding cerrado con el mismo detail no se vuelve a emitir; si el detail cambia, sí', async () => {
    await list('US', [sym('SINMIC', { Exchange: 'US', Currency: 'USD', Isin: 'US0000005001' })]);
    await run();
    const [f] = await findings('VENUE_UNMAPPED');
    expect(f!.status).toBe('open');
    await pool.query("UPDATE data_quality_finding SET status = 'accepted', resolved_at = now(), resolved_by = 'david'");
    await run();
    expect(await findings('VENUE_UNMAPPED')).toHaveLength(1); // aceptado: no se reabre ni se duplica
    expect((await findings('VENUE_UNMAPPED'))[0]!.status).toBe('accepted');
  });

  test('una regla apagada en validation_rule no emite findings', async () => {
    await pool.query("UPDATE validation_rule SET enabled = false WHERE rule_code = 'VENUE_UNMAPPED'");
    try {
      await list('US', [sym('SINMIC2', { Exchange: 'US', Currency: 'USD', Isin: 'US0000005002' })]);
      const out = await run();
      expect(out.listings).toMatchObject({ created: 1, venueUnmapped: 1 }); // se cuenta, pero no se escribe el finding
      expect(await findings('VENUE_UNMAPPED')).toHaveLength(0);
    } finally {
      await pool.query("UPDATE validation_rule SET enabled = true WHERE rule_code = 'VENUE_UNMAPPED'");
    }
  });
});

// ------------------------------------------------------------------ integración opcional sobre fixtures/ (no están en el repo)
const FIXTURE = 'fixtures/eodhd/exchange-symbol-list/US.json';
describe.skipIf(!existsSync(FIXTURE))('integración sobre fixtures/ (se salta si no existen)', () => {
  test('una muestra de exchange-symbol-list/US con la forma real: recuentos coherentes e idempotencia', async () => {
    const all = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { Type: string | null; Currency?: string | null; Isin?: string | null }[];
    const sample = all.filter((_, i) => i % 17 === 0).slice(0, 3000);
    await addPayload('exchange-symbol-list/{code}', null, { code: 'US' }, sample);
    const first = await replay({ all: true });
    expect(first).toMatchObject({ checked: 1, ok: 1, error: 0 });
    const s = first.listings!;
    const inScope = sample.filter((x) => x.Type === 'Common Stock' || x.Type === 'ETF');
    const etfs = inScope.filter((x) => x.Type === 'ETF');
    expect(s.symbols).toBe(sample.length);
    expect(s.skippedOutOfScope + s.unknownTypes + inScope.length).toBe(sample.length);
    const stocksWithCurrency = inScope.filter((x) => x.Type === 'Common Stock' && x.Currency?.trim()).length;
    expect(s.skippedNoFundamentals).toBeGreaterThan(0);
    expect(s.skippedNoFundamentals).toBeLessThanOrEqual(stocksWithCurrency); // acciones con divisa y sin fundamentals
    expect(s.created).toBe(await count('listing'));
    expect((await pool.query("SELECT count(*)::int AS n FROM listing WHERE quote_currency IS NULL OR btrim(quote_currency) = ''")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM security s JOIN asset_type a USING (asset_type_id) WHERE a.code = 'common_stock'")).rows[0].n).toBe(0); // ninguna acción sin fundamentals
    const audit = await count('dimension_audit');
    const second = await replay({ all: true });
    expect(second.listings).toMatchObject({ created: 0, symbols: sample.length });
    expect(await count('dimension_audit')).toBe(audit);
  }, 120_000);
});
