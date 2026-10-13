import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { replay } from '../src/eodhd/replay.js';

// Cuerpos sintéticos con la forma real de fundamentals/{symbol}: General, Financials.{Balance_Sheet,Income_Statement,Cash_Flow}
// (currency_symbol, quarterly, yearly: fecha -> línea con filing_date), outstandingShares.quarterly y ETF_Data. Valores de prueba.
async function cleanAll() {
  for (const sql of [
    'DELETE FROM data_quality_finding', 'DELETE FROM fundamentals', 'DELETE FROM shares_outstanding', 'DELETE FROM etf_holding', 'DELETE FROM etf_allocation',
    'DELETE FROM etf_snapshot', 'DELETE FROM etf_profile', 'DELETE FROM listing', 'DELETE FROM security', 'DELETE FROM company',
    'DELETE FROM source_sector_map', 'DELETE FROM industry', 'DELETE FROM sector',
    'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run',
    "DELETE FROM dimension_audit WHERE table_name IN ('company', 'security', 'listing', 'etf_profile', 'sector', 'industry', 'source_sector_map')",
  ]) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(async () => { runId = ''; await cleanAll(); });

let runId = '';
async function fundamentals(symbol: string, body: unknown, fetchedAt = '2026-10-12T10:00:00Z'): Promise<string> {
  if (!runId) runId = (await pool.query<{ id: string }>("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd', 'test:fundamentals', 'ok', now()) RETURNING ingestion_run_id AS id")).rows[0]!.id;
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query('INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [hash, bytes, bytes.length]);
  return (await pool.query<{ id: string }>(
    'INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash, fetched_at) VALUES ($1,$2,$3,$4::jsonb,200,$5,$6) RETURNING raw_payload_id AS id',
    [runId, 'fundamentals/{symbol}', symbol, '{}', hash, fetchedAt],
  )).rows[0]!.id;
}

// Una acción: company + security + listing (primario por defecto). Devuelve ids.
async function makeStock(symbol: string, opts: { primary?: boolean; security?: string; company?: string } = {}) {
  const company = opts.company ?? (await pool.query<{ id: string }>("INSERT INTO company (legal_name, cik, identity_source) VALUES ($1, $2, 'cik') RETURNING company_id AS id", [`Empresa ${symbol}`, `cik-${symbol}`])).rows[0]!.id;
  const security = opts.security ?? (await pool.query<{ id: string }>("INSERT INTO security (company_id, asset_type_id) VALUES ($1, (SELECT asset_type_id FROM asset_type WHERE code = 'common_stock')) RETURNING security_id AS id", [company])).rows[0]!.id;
  await pool.query("INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency, status, is_primary_listing) VALUES ($1, $2, $3, 'USD', 'active', $4)", [security, symbol.split('.')[0], symbol, opts.primary ?? true]);
  return { company, security };
}
async function makeEtf(symbol: string, mic: string | null = 'ARCX') {
  const security = (await pool.query<{ id: string }>("INSERT INTO security (company_id, asset_type_id) VALUES (NULL, (SELECT asset_type_id FROM asset_type WHERE code = 'etf')) RETURNING security_id AS id")).rows[0]!.id;
  await pool.query("INSERT INTO listing (security_id, exchange_id, ticker, provider_symbol, quote_currency, status, is_primary_listing) VALUES ($1, (SELECT exchange_id FROM exchange WHERE mic = $4), $2, $3, 'USD', 'active', true)", [security, symbol.split('.')[0], symbol, mic]);
  return { security };
}

// Estados de un periodo. `over` pisa campos de cada estado.
const bs = (d: string, filing: string | null, over: Record<string, unknown> = {}) => ({ date: d, filing_date: filing, currency_symbol: 'USD', totalAssets: '1000.00', cash: '100.00', totalStockholderEquity: '400.00', shortLongTermDebtTotal: '250.00', shortTermDebt: '60.00', longTermDebt: '150.00', totalLiab: '600.00', ...over });
const is = (d: string, filing: string | null, over: Record<string, unknown> = {}) => ({ date: d, filing_date: filing, currency_symbol: 'USD', totalRevenue: '500.00', grossProfit: '200.00', ebitda: '90.00', operatingIncome: '70.00', netIncome: '50.00', ...over });
const cf = (d: string, filing: string | null, over: Record<string, unknown> = {}) => ({ date: d, filing_date: filing, currency_symbol: 'USD', totalCashFromOperatingActivities: '80.00', capitalExpenditures: '30', ...over });
const sections = (q: Record<string, [unknown, unknown, unknown]>, y: Record<string, [unknown, unknown, unknown]> = {}, cur: string | null = 'USD') => ({
  Financials: {
    Balance_Sheet: { currency_symbol: cur, quarterly: Object.fromEntries(Object.entries(q).map(([d, v]) => [d, v[0]])), yearly: Object.fromEntries(Object.entries(y).map(([d, v]) => [d, v[0]])) },
    Income_Statement: { currency_symbol: cur, quarterly: Object.fromEntries(Object.entries(q).map(([d, v]) => [d, v[1]])), yearly: Object.fromEntries(Object.entries(y).map(([d, v]) => [d, v[1]])) },
    Cash_Flow: { currency_symbol: cur, quarterly: Object.fromEntries(Object.entries(q).map(([d, v]) => [d, v[2]])), yearly: Object.fromEntries(Object.entries(y).map(([d, v]) => [d, v[2]])) },
  },
});
const stockBody = (extra: Record<string, unknown> = {}, general: Record<string, unknown> = {}) => ({ General: { Code: 'X', Type: 'Common Stock', Sector: 'Technology', Industry: 'Software', ...general }, ...extra });

const rows = async () => (await pool.query(
  `SELECT period_end::text AS period_end, period_type, reported_at::text AS reported_at, reported_at_source AS src, currency, revenue::text AS revenue, gross_profit::text AS gross_profit,
          ebitda::text AS ebitda, operating_income::text AS operating_income, net_income::text AS net_income, operating_cf::text AS operating_cf, capex::text AS capex,
          total_debt::text AS total_debt, short_term_debt::text AS short_term_debt, long_term_debt::text AS long_term_debt, total_liabilities::text AS total_liabilities, cash::text AS cash, total_equity::text AS total_equity, total_assets::text AS total_assets FROM fundamentals ORDER BY period_type, period_end, reported_at`)).rows;
const findings = async (rule: string) => (await pool.query('SELECT target_table, target_key, severity, status, detail FROM data_quality_finding WHERE rule_code = $1 ORDER BY finding_id', [rule])).rows;
const count = async (table: string) => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

describe('FUNDAMENTALS (acciones)', () => {
  test('los tres estados se fusionan por periodo y tipo; reported_at = última filing_date (provider); líneas en la unidad del proveedor', async () => {
    await makeStock('FFA.US');
    await fundamentals('FFA.US', stockBody(sections(
      { '2026-06-30': [bs('2026-06-30', '2026-07-30'), is('2026-06-30', '2026-07-31'), cf('2026-06-30', '2026-07-29')] },
      { '2025-09-30': [bs('2025-09-30', '2025-10-31'), is('2025-09-30', '2025-10-31'), cf('2025-09-30', '2025-10-31')] },
    )));
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0, deferred: 0 });
    expect(out.fundamentals).toMatchObject({ payloads: 1, periods: 2, fundamentalsInserted: 2, fundamentalsRevised: 0, discarded: 0 });
    expect(await rows()).toEqual([
      { period_end: '2025-09-30', period_type: 'A', reported_at: '2025-10-31', src: 'provider', currency: 'USD', revenue: '500.00', gross_profit: '200.00', ebitda: '90.00', operating_income: '70.00', net_income: '50.00', operating_cf: '80.00', capex: '30', total_debt: '250.00', short_term_debt: '60.00', long_term_debt: '150.00', total_liabilities: '600.00', cash: '100.00', total_equity: '400.00', total_assets: '1000.00' },
      { period_end: '2026-06-30', period_type: 'Q', reported_at: '2026-07-31', src: 'provider', currency: 'USD', revenue: '500.00', gross_profit: '200.00', ebitda: '90.00', operating_income: '70.00', net_income: '50.00', operating_cf: '80.00', capex: '30', total_debt: '250.00', short_term_debt: '60.00', long_term_debt: '150.00', total_liabilities: '600.00', cash: '100.00', total_equity: '400.00', total_assets: '1000.00' },
    ]);
  });

  test('sin filing_date: period_end + 45 días y estimated; un filing_date anterior al cierre se ignora', async () => {
    await makeStock('FFB.US');
    await fundamentals('FFB.US', stockBody(sections({
      '2026-03-31': [bs('2026-03-31', null), is('2026-03-31', null), cf('2026-03-31', null)],
      '2026-06-30': [bs('2026-06-30', '2026-01-01'), is('2026-06-30', null), cf('2026-06-30', null)],
    })));
    await replay();
    expect((await rows()).map((r) => [r.period_end, r.reported_at, r.src])).toEqual([['2026-03-31', '2026-05-15', 'estimated'], ['2026-06-30', '2026-08-14', 'estimated']]);
  });

  test('periodo con solo algún estado: las líneas que faltan quedan NULL; la divisa de una fila vacía sale del bloque, nunca de la cotización', async () => {
    await makeStock('FFC.US');
    const q = '2026-06-30';
    await fundamentals('FFC.US', stockBody(sections({ [q]: [bs(q, '2026-07-31', { currency_symbol: null }), null, null] } as never, {}, 'EUR')));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ periods: 1, discarded: 0 });
    expect(await rows()).toEqual([expect.objectContaining({ currency: 'EUR', revenue: null, operating_cf: null, total_assets: '1000.00', cash: '100.00' })]);
  });

  test('periodo sin divisa en ningún sitio: no se crea y FUNDAMENTALS_INCOMPLETE guarda el motivo', async () => {
    await makeStock('FFD.US');
    const q = '2026-06-30';
    const id = await fundamentals('FFD.US', stockBody(sections({ [q]: [bs(q, '2026-07-31', { currency_symbol: null }), is(q, '2026-07-31', { currency_symbol: null }), cf(q, '2026-07-31', { currency_symbol: null })] }, {}, null)));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ periods: 0, discarded: 1 });
    expect(await count('fundamentals')).toBe(0);
    const f = await findings('FUNDAMENTALS_INCOMPLETE');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'raw_payload', target_key: { raw_payload_id: Number(id) }, severity: 'warning', status: 'open' });
    expect(f[0]!.detail.items[0]).toMatchObject({ reason: 'periodo sin divisa de reporte' });
  });

  test('idempotente: repetir deja las mismas filas, ningún finding y nada nuevo', async () => {
    await makeStock('FFE.US');
    await fundamentals('FFE.US', stockBody({ ...sections({ '2026-06-30': [bs('2026-06-30', '2026-07-31'), is('2026-06-30', '2026-07-31'), cf('2026-06-30', '2026-07-31')] }), outstandingShares: { quarterly: { 0: { date: '2026-Q2', dateFormatted: '2026-06-30', shares: '1000' } } } }));
    await replay();
    const again = await replay({ all: true });
    expect(again.fundamentals).toMatchObject({ fundamentalsInserted: 0, fundamentalsUnchanged: 1, fundamentalsFilled: 0, fundamentalsRevised: 0, sharesInserted: 0, sharesUnchanged: 1 });
    expect(await count('fundamentals')).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM data_quality_finding WHERE rule_code LIKE 'FUNDAMENTALS%'")).rows[0].n).toBe(0);
  });

  test('P16, misma clave y misma filing_date: NULL -> valor en silencio; valor distinto = UPDATE + FUNDAMENTALS_REVISED solo con las columnas cambiadas y el old del primero', async () => {
    await makeStock('FFF.US');
    const q = '2026-06-30';
    await fundamentals('FFF.US', stockBody(sections({ [q]: [bs(q, '2026-07-31'), is(q, '2026-07-31', { grossProfit: null }), cf(q, '2026-07-31')] })));
    await replay();
    // solo completa gross_profit: en silencio
    await fundamentals('FFF.US', stockBody(sections({ [q]: [bs(q, '2026-07-31'), is(q, '2026-07-31', { grossProfit: '210.00' }), cf(q, '2026-07-31')] })));
    let out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ fundamentalsInserted: 0, fundamentalsFilled: 1, fundamentalsRevised: 0 });
    expect(await findings('FUNDAMENTALS_REVISED')).toHaveLength(0);
    // corrige net_income (y completa nada más): UPDATE + finding
    await fundamentals('FFF.US', stockBody(sections({ [q]: [bs(q, '2026-07-31'), is(q, '2026-07-31', { grossProfit: '210.00', netIncome: '55.00' }), cf(q, '2026-07-31')] })));
    out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ fundamentalsInserted: 0, fundamentalsRevised: 1 });
    expect(await rows()).toEqual([expect.objectContaining({ gross_profit: '210.00', net_income: '55.00' })]);
    let f = await findings('FUNDAMENTALS_REVISED');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'fundamentals', status: 'open', severity: 'warning', detail: { old: { net_income: 50 }, new: { net_income: 55 } } });
    expect(Object.keys(f[0]!.detail.new)).toEqual(['net_income']);
    // otra corrección de la misma línea: el finding conserva el old del primero
    await fundamentals('FFF.US', stockBody(sections({ [q]: [bs(q, '2026-07-31'), is(q, '2026-07-31', { grossProfit: '210.00', netIncome: '60.00' }), cf(q, '2026-07-31')] })));
    await replay({ all: true });
    f = await findings('FUNDAMENTALS_REVISED');
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatchObject({ old: { net_income: 50 }, new: { net_income: 60 } });
    // una línea que llega vacía no borra el dato guardado
    await fundamentals('FFF.US', stockBody(sections({ [q]: [bs(q, '2026-07-31'), is(q, '2026-07-31', { grossProfit: '210.00', netIncome: null }), cf(q, '2026-07-31')] })));
    await replay({ all: true });
    expect(await rows()).toEqual([expect.objectContaining({ net_income: '60.00' })]);
  });

  test('P14: total_debt es el del proveedor; short_term_debt y long_term_debt se guardan aparte y el total nunca se rellena con su suma', async () => {
    await makeStock('FFD.US');
    const q = '2026-06-30';
    await fundamentals('FFD.US', stockBody(sections({ [q]: [bs(q, '2026-07-31', { shortLongTermDebtTotal: null }), is(q, '2026-07-31'), cf(q, '2026-07-31')] })));
    await replay();
    expect(await rows()).toEqual([expect.objectContaining({ total_debt: null, short_term_debt: '60.00', long_term_debt: '150.00', total_liabilities: '600.00' })]);
  });

  test('un restatement con filing_date posterior es una fila nueva y conserva la anterior', async () => {
    await makeStock('FFG.US');
    const q = '2026-06-30';
    await fundamentals('FFG.US', stockBody(sections({ [q]: [bs(q, '2026-07-31'), is(q, '2026-07-31'), cf(q, '2026-07-31')] })));
    await replay();
    await fundamentals('FFG.US', stockBody(sections({ [q]: [bs(q, '2026-09-15'), is(q, '2026-09-15', { netIncome: '45.00' }), cf(q, '2026-09-15')] })));
    await replay({ all: true });
    expect((await rows()).map((r) => [r.reported_at, r.net_income])).toEqual([['2026-07-31', '50.00'], ['2026-09-15', '45.00']]);
    expect((await pool.query("SELECT count(*)::int AS n FROM data_quality_finding WHERE rule_code LIKE 'FUNDAMENTALS%'")).rows[0].n).toBe(0);
  });

  test('SHARES_OUTSTANDING: reported_at derivado de la filing_date del mismo periodo (provider_derived) o estimado; solo la serie trimestral; sin cifra se descarta', async () => {
    const { security } = await makeStock('FFH.US');
    const q = '2026-06-30';
    const id = await fundamentals('FFH.US', stockBody({
      ...sections({ [q]: [bs(q, '2026-07-31'), is(q, '2026-07-31'), cf(q, '2026-07-31')] }),
      outstandingShares: {
        annual: { 0: { date: '2026', dateFormatted: '2026-12-31', shares: '999' } },
        quarterly: { 0: { date: '2026-Q2', dateFormatted: q, shares: '14750302000' }, 1: { date: '2026-Q1', dateFormatted: '2026-03-31', shares: '14800000000' }, 2: { date: '2025-Q4', dateFormatted: '2025-12-31', shares: null } },
      },
    }));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ sharesInserted: 2, discarded: 1 });
    const r = (await pool.query('SELECT security_id::text AS s, period_end::text AS period_end, reported_at::text AS reported_at, reported_at_source AS src, shares::text AS shares FROM shares_outstanding ORDER BY period_end')).rows;
    expect(r).toEqual([
      { s: security, period_end: '2026-03-31', reported_at: '2026-05-15', src: 'estimated', shares: '14800000000' },
      { s: security, period_end: q, reported_at: '2026-07-31', src: 'provider_derived', shares: '14750302000' },
    ]);
    expect((await findings('FUNDAMENTALS_INCOMPLETE'))[0]).toMatchObject({ target_key: { raw_payload_id: Number(id) } });
  });

  test('SHARES_OUTSTANDING: una cifra distinta para la misma clave se corrige (UPDATE) y emite FUNDAMENTALS_REVISED', async () => {
    await makeStock('FFI.US');
    const body = (shares: string) => stockBody({ outstandingShares: { quarterly: { 0: { date: '2026-Q2', dateFormatted: '2026-06-30', shares } } } });
    await fundamentals('FFI.US', body('1000'));
    await replay();
    await fundamentals('FFI.US', body('1100'));
    const out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ sharesRevised: 1 });
    expect((await pool.query('SELECT shares::text AS shares FROM shares_outstanding')).rows).toEqual([{ shares: '1100' }]);
    expect((await findings('FUNDAMENTALS_REVISED'))[0]).toMatchObject({ target_table: 'shares_outstanding', detail: { old: { shares: '1000' }, new: { shares: '1100' } } });
  });

  test('sector: etiqueta sin mapeo -> company queda NULL + SECTOR_UNMAPPED; con mapeo (industria exacta o solo sector) se asigna', async () => {
    const a = await makeStock('SEA.US'), b = await makeStock('SEB.US'), c2 = await makeStock('SEC.US');
    const sec = (await pool.query<{ id: string }>("INSERT INTO sector (code, name) VALUES ('tec', 'Tecnología') RETURNING sector_id AS id")).rows[0]!.id;
    const ind = (await pool.query<{ id: string }>("INSERT INTO industry (sector_id, code, name) VALUES ($1, 'sw', 'Software') RETURNING industry_id AS id", [sec])).rows[0]!.id;
    await pool.query("INSERT INTO source_sector_map (provider, provider_sector_label, provider_industry_label, sector_id, industry_id) VALUES ('eodhd', 'Technology', 'Software', $1, $2), ('eodhd', 'Technology', '', $1, NULL)", [sec, ind]);
    await fundamentals('SEA.US', stockBody({}, { Sector: 'Technology', Industry: 'Software' }));
    await fundamentals('SEB.US', stockBody({}, { Sector: 'Technology', Industry: 'Otra cosa' }));
    await fundamentals('SEC.US', stockBody({}, { Sector: 'Raro', Industry: 'X' }));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ sectorMapped: 2, sectorUnmapped: 1 });
    const s = async (company: string) => (await pool.query('SELECT sector_id::text AS s, industry_id::text AS i FROM company WHERE company_id = $1', [company])).rows[0];
    expect(await s(a.company)).toEqual({ s: sec, i: ind });
    expect(await s(b.company)).toEqual({ s: sec, i: null });
    expect(await s(c2.company)).toEqual({ s: null, i: null });
    const f = await findings('SECTOR_UNMAPPED');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'company', target_key: { company_id: Number(c2.company) }, severity: 'warning', detail: { sector: 'Raro', industry: 'X' } });
    await replay({ all: true });
    expect(await findings('SECTOR_UNMAPPED')).toHaveLength(1); // no se duplica
  });

  test('el payload de un listing no primario se marca ok y se salta, contando; sin listing queda pendiente', async () => {
    const { security, company } = await makeStock('PRI.US');
    await makeStock('0PRI.LSE', { primary: false, security, company });
    await fundamentals('0PRI.LSE', stockBody(sections({ '2026-06-30': [bs('2026-06-30', '2026-07-31'), is('2026-06-30', '2026-07-31'), cf('2026-06-30', '2026-07-31')] })));
    const id = await fundamentals('NOLIST.US', stockBody());
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, deferred: 1 });
    expect(out.fundamentals).toMatchObject({ payloads: 1, skippedNonPrimary: 1, fundamentalsInserted: 0 });
    expect(await count('fundamentals')).toBe(0);
    expect((await pool.query('SELECT parse_status FROM raw_payload WHERE raw_payload_id = $1', [id])).rows[0].parse_status).toBe('pending');
  });
});

describe('ETF', () => {
  const etfBody = (over: Record<string, unknown> = {}, etfOver: Record<string, unknown> = {}) => ({
    General: { Code: 'E', Type: 'ETF', CurrencyCode: 'USD', Category: null, ...over },
    ETF_Data: {
      ISIN: 'US0000000001', Company_Name: 'Gestora', Domicile: 'United States', Index_Name: null, Inception_Date: '2001-05-24', NetExpenseRatio: '0.0003', TotalAssets: '704958596680.00',
      Sector_Weights: { Technology: { 'Equity_%': '34.6031' }, 'Consumer Cyclicals': { 'Equity_%': '9.4566' } },
      World_Regions: { 'North America': { 'Equity_%': '104.0175' }, Japan: { 'Equity_%': '0' } },
      Market_Capitalisation: { Mega: '41.0366', Big: '29.8774' },
      Asset_Allocation: { 'Stock US': { 'Long_%': '98.3567', 'Short_%': '0', 'Net_Assets_%': '98.3567' }, Cash: { 'Long_%': '0.1919', 'Short_%': '0.0122', 'Net_Assets_%': '0.1939' } },
      Holdings: { 'NVDA.US': { Code: 'NVDA', Name: 'NVIDIA', 'Assets_%': '6.0681' }, 'XXON.TO': { Code: 'XXON', Name: 'Exxon', 'Assets_%': '0.7839' } },
      ...etfOver,
    },
  });

  test('ETF_PROFILE, ETF_SNAPSHOT (TotalAssets en la divisa del listing), ETF_HOLDING y ETF_ALLOCATION del proveedor; allocation de asset_class en neto', async () => {
    const { security } = await makeEtf('EEA.US');
    await fundamentals('EEA.US', etfBody());
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
    expect(out.fundamentals).toMatchObject({ etfProfileChanged: 1, etfSnapshotInserted: 1, etfHoldingsInserted: 2, etfAllocationInserted: 8, discarded: 0 });
    expect((await pool.query('SELECT issuer, inception_date::text AS inception_date, index_tracked, category, domicile, expense_ratio::text AS expense_ratio FROM etf_profile WHERE security_id = $1', [security])).rows)
      .toEqual([{ issuer: 'Gestora', inception_date: '2001-05-24', index_tracked: null, category: null, domicile: 'United States', expense_ratio: '0.0003' }]);
    expect((await pool.query('SELECT as_of_date::text AS d, aum::text AS aum, nav, currency, shares_outstanding_etf AS sh FROM etf_snapshot')).rows).toEqual([{ d: '2026-10-12', aum: '704958596680.00', nav: null, currency: 'USD', sh: null }]);
    expect((await pool.query('SELECT constituent_symbol AS s, constituent_name AS n, weight_pct::text AS w, constituent_security_id AS id, market_value, shares_held FROM etf_holding ORDER BY 1')).rows)
      .toEqual([{ s: 'NVDA.US', n: 'NVIDIA', w: '6.0681', id: null, market_value: null, shares_held: null }, { s: 'XXON.TO', n: 'Exxon', w: '0.7839', id: null, market_value: null, shares_held: null }]);
    expect((await pool.query("SELECT dimension, bucket, weight_pct::text AS w, source, sector_id FROM etf_allocation ORDER BY dimension, bucket")).rows).toEqual([
      { dimension: 'asset_class', bucket: 'Cash', w: '0.1939', source: 'provider', sector_id: null },
      { dimension: 'asset_class', bucket: 'Stock US', w: '98.3567', source: 'provider', sector_id: null },
      { dimension: 'market_cap', bucket: 'Big', w: '29.8774', source: 'provider', sector_id: null },
      { dimension: 'market_cap', bucket: 'Mega', w: '41.0366', source: 'provider', sector_id: null },
      { dimension: 'region', bucket: 'Japan', w: '0', source: 'provider', sector_id: null },
      { dimension: 'region', bucket: 'North America', w: '104.0175', source: 'provider', sector_id: null },
      { dimension: 'sector', bucket: 'Consumer Cyclicals', w: '9.4566', source: 'provider', sector_id: null },
      { dimension: 'sector', bucket: 'Technology', w: '34.6031', source: 'provider', sector_id: null },
    ]);
  });

  test('P15: el aum solo se guarda si el listing primario cotiza en EEUU; en otra bolsa o sin bolsa no hay snapshot ni finding', async () => {
    await makeEtf('EEL.LSE', 'XLON');
    await makeEtf('EEM.US', null);
    await fundamentals('EEL.LSE', etfBody({ CurrencyCode: 'GBX' }));
    await fundamentals('EEM.US', etfBody());
    const out = await replay();
    expect(out).toMatchObject({ checked: 2, ok: 2, error: 0 });
    expect(out.fundamentals).toMatchObject({ etfSnapshotInserted: 0, etfSnapshotNoCurrency: 2, discarded: 0 });
    expect(await count('etf_snapshot')).toBe(0);
    expect(await count('etf_holding')).toBe(4); // el resto del payload sí entra
    expect(await findings('FUNDAMENTALS_INCOMPLETE')).toHaveLength(0);
  });

  test('la allocation de sector se mapea por SOURCE_SECTOR_MAP; un bucket sin mapeo queda NULL + SECTOR_UNMAPPED (una vez por ETF y bucket)', async () => {
    const { security } = await makeEtf('EEB.US');
    const sec = (await pool.query<{ id: string }>("INSERT INTO sector (code, name) VALUES ('tec', 'Tecnología') RETURNING sector_id AS id")).rows[0]!.id;
    await pool.query("INSERT INTO source_sector_map (provider, provider_sector_label, provider_industry_label, sector_id) VALUES ('eodhd', 'Technology', '', $1)", [sec]);
    await fundamentals('EEB.US', etfBody());
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ sectorMapped: 1, sectorUnmapped: 1 });
    expect((await pool.query("SELECT bucket, sector_id::text AS s FROM etf_allocation WHERE dimension = 'sector' ORDER BY bucket")).rows).toEqual([{ bucket: 'Consumer Cyclicals', s: null }, { bucket: 'Technology', s: sec }]);
    const f = await findings('SECTOR_UNMAPPED');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'etf_allocation', target_key: { security_id: Number(security), bucket: 'Consumer Cyclicals' }, severity: 'warning' });
  });

  test('idempotente y deduplicación por valor: el mismo contenido otro día no inserta snapshot, holdings ni allocation', async () => {
    await makeEtf('EEC.US');
    await fundamentals('EEC.US', etfBody());
    await replay();
    await fundamentals('EEC.US', etfBody(), '2026-10-19T10:00:00Z');
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ etfProfileChanged: 0, etfSnapshotInserted: 0, etfHoldingsInserted: 0, etfHoldingsUnchangedSets: 1, etfAllocationInserted: 0, etfAllocationUnchangedSets: 1 });
    expect(await count('etf_snapshot')).toBe(1);
    expect(await count('etf_holding')).toBe(2);
    expect(await count('etf_allocation')).toBe(8);
    const again = await replay({ all: true });
    expect(again.fundamentals).toMatchObject({ etfSnapshotInserted: 0, etfHoldingsInserted: 0, etfAllocationInserted: 0 });
  });

  test('si el contenido cambia, snapshot nuevo con su fecha de observación; el anterior se conserva', async () => {
    await makeEtf('EED.US');
    await fundamentals('EED.US', etfBody());
    await replay();
    const changed = etfBody({}, { TotalAssets: '800000000000.00', Holdings: { 'NVDA.US': { Code: 'NVDA', Name: 'NVIDIA', 'Assets_%': '6.5' }, 'XXON.TO': { Code: 'XXON', Name: 'Exxon', 'Assets_%': '0.7839' } }, Market_Capitalisation: { Mega: '42', Big: '29.8774' } });
    await fundamentals('EED.US', changed, '2026-10-19T10:00:00Z');
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ etfSnapshotInserted: 1, etfHoldingsInserted: 2, etfAllocationInserted: 8 });
    expect((await pool.query('SELECT as_of_date::text AS d, aum::text AS aum FROM etf_snapshot ORDER BY 1')).rows).toEqual([{ d: '2026-10-12', aum: '704958596680.00' }, { d: '2026-10-19', aum: '800000000000.00' }]);
    expect(await count('etf_holding')).toBe(4);
  });

  test('el constituyente se resuelve por LISTING.provider_symbol, y una resolución posterior completa el snapshot ya guardado', async () => {
    await makeEtf('EEE.US');
    const nv = await makeStock('NVDA.US');
    await fundamentals('EEE.US', etfBody());
    await replay();
    const r = async () => (await pool.query("SELECT constituent_symbol AS s, constituent_security_id::text AS id FROM etf_holding ORDER BY 1")).rows;
    expect(await r()).toEqual([{ s: 'NVDA.US', id: nv.security }, { s: 'XXON.TO', id: null }]);
    const xom = await makeStock('XXON.TO');
    const out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ etfHoldingsUnchangedSets: 1, etfHoldingsResolved: 1 });
    expect(await r()).toEqual([{ s: 'NVDA.US', id: nv.security }, { s: 'XXON.TO', id: xom.security }]);
  });

  test('NetExpenseRatio fuera de [0, 0.1) no entra (queda NULL) y deja FUNDAMENTALS_INCOMPLETE; el 0 se guarda', async () => {
    const a = await makeEtf('EEF.US'), b = await makeEtf('EEG.US');
    await fundamentals('EEF.US', etfBody({}, { NetExpenseRatio: '0.20' }));
    await fundamentals('EEG.US', etfBody({}, { NetExpenseRatio: '0.00' }));
    const out = await replay();
    expect(out).toMatchObject({ checked: 2, ok: 2, error: 0 });
    expect((await pool.query('SELECT security_id::text AS s, expense_ratio::text AS e FROM etf_profile ORDER BY 1')).rows).toEqual([{ s: a.security, e: null }, { s: b.security, e: '0.00' }]);
    const f = await findings('FUNDAMENTALS_INCOMPLETE');
    expect(f).toHaveLength(1);
    expect(f[0]!.detail.items[0]).toMatchObject({ reason: expect.stringContaining('NetExpenseRatio') });
  });

  test('holdings sin Assets_%, TotalAssets sin divisa y un ETF sin ETF_Data dejan rastro y no tumban el payload', async () => {
    await makeEtf('EEH.US');
    await makeEtf('EEI.US');
    await fundamentals('EEH.US', etfBody({ CurrencyCode: null }, { Holdings: { 'AAA.US': { Name: 'sin peso' }, 'BBB.US': { Name: 'ok', 'Assets_%': '1' } } }));
    await fundamentals('EEI.US', { General: { Type: 'ETF' } });
    const out = await replay();
    expect(out).toMatchObject({ checked: 2, ok: 2, error: 0 });
    expect(await count('etf_snapshot')).toBe(0);
    expect(await count('etf_holding')).toBe(1);
    const reasons = (await findings('FUNDAMENTALS_INCOMPLETE')).flatMap((f) => f.detail.items.map((x: { reason: string }) => x.reason)).sort();
    expect(reasons).toEqual(['TotalAssets sin divisa (General.CurrencyCode ausente)', 'holding sin Assets_%', 'sin bloque ETF_Data']);
  });
});
