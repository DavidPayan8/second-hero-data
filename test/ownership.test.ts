import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { replay } from '../src/eodhd/replay.js';

// Escritores de earnings, ownership, analistas, short interest, holders e insiders: bloques de fundamentals/{symbol} de una acción.
// Cuerpos sintéticos con la forma de los payloads reales de AAPL, TSLA y AMZN (clave demo). Valores de prueba.
async function cleanAll() {
  for (const sql of [
    'DELETE FROM data_quality_finding', 'DELETE FROM earnings', 'DELETE FROM analyst_consensus', 'DELETE FROM ownership_snapshot', 'DELETE FROM short_interest',
    'DELETE FROM holder_position', 'DELETE FROM insider_transaction', 'DELETE FROM fundamentals', 'DELETE FROM shares_outstanding',
    'DELETE FROM listing', 'DELETE FROM security', 'DELETE FROM company',
    'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run',
    "DELETE FROM dimension_audit WHERE table_name IN ('company', 'security', 'listing')",
  ]) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(async () => { runId = ''; await cleanAll(); });

let runId = '';
async function fundamentals(symbol: string, body: unknown, fetchedAt = '2026-10-12T10:00:00Z'): Promise<string> {
  if (!runId) runId = (await pool.query<{ id: string }>("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd', 'test:ownership', 'ok', now()) RETURNING ingestion_run_id AS id")).rows[0]!.id;
  const bytes = Buffer.from(JSON.stringify(body));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query('INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [hash, bytes, bytes.length]);
  return (await pool.query<{ id: string }>(
    'INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash, fetched_at) VALUES ($1,$2,$3,$4::jsonb,200,$5,$6) RETURNING raw_payload_id AS id',
    [runId, 'fundamentals/{symbol}', symbol, '{}', hash, fetchedAt],
  )).rows[0]!.id;
}
async function makeStock(symbol: string, mic: string | null = null) {
  const company = (await pool.query<{ id: string }>("INSERT INTO company (legal_name, cik, identity_source) VALUES ($1, $2, 'cik') RETURNING company_id AS id", [`Empresa ${symbol}`, `cik-${symbol}`])).rows[0]!.id;
  const security = (await pool.query<{ id: string }>("INSERT INTO security (company_id, asset_type_id) VALUES ($1, (SELECT asset_type_id FROM asset_type WHERE code = 'common_stock')) RETURNING security_id AS id", [company])).rows[0]!.id;
  await pool.query("INSERT INTO listing (security_id, exchange_id, ticker, provider_symbol, quote_currency, status, is_primary_listing) VALUES ($1, (SELECT exchange_id FROM exchange WHERE mic = $4), $2, $3, 'USD', 'active', true)", [security, symbol.split('.')[0], symbol, mic]);
  return { security };
}
const body = (extra: Record<string, unknown> = {}) => ({ General: { Code: 'X', Type: 'Common Stock', UpdatedAt: '2026-10-11', CurrencyCode: 'USD' }, ...extra });
const findings = async (rule: string) => (await pool.query('SELECT target_table, target_key, detail FROM data_quality_finding WHERE rule_code = $1 ORDER BY finding_id', [rule])).rows;
const count = async (table: string) => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

describe('EARNINGS', () => {
  const hist = (over: Record<string, unknown> = {}) => ({
    '2026-09-30': { reportDate: '2026-11-02', date: '2026-09-30', beforeAfterMarket: 'AfterMarket', currency: null, epsActual: null, epsEstimate: 1.98, epsDifference: 0, surprisePercent: null },
    '2026-06-30': { reportDate: '2026-07-30', date: '2026-06-30', beforeAfterMarket: 'BeforeMarket', currency: 'USD', epsActual: 2.02, epsEstimate: 1.88, epsDifference: 0.14, surprisePercent: 7.4468 },
    '1993-12-31': { reportDate: '1993-12-31', date: '1993-12-31', beforeAfterMarket: null, currency: 'USD', epsActual: 0.0031, epsEstimate: null, epsDifference: 0, surprisePercent: null },
    ...over,
  });
  const rows = async () => (await pool.query(
    `SELECT fiscal_period_end::text AS end, period_type, report_date::text AS report_date, report_time, eps_estimate::text AS eps, revenue_estimate, estimate_currency AS cur, is_reported AS rep FROM earnings ORDER BY 1`)).rows;

  test('una fila por periodo trimestral: fecha y hora de reporte; el estimado solo con divisa; la futura queda con la fila de calendario y sin estimado, sin finding', async () => {
    const { security } = await makeStock('EAA.US');
    await fundamentals('EAA.US', body({ Earnings: { History: hist(), Annual: { '2026-09-30': { date: '2026-09-30', epsActual: 6.87 } } } }));
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
    expect(out.fundamentals).toMatchObject({ earningsInserted: 3, earningsUpdated: 0, earningsEstimateNoCurrency: 1, discarded: 0 });
    expect(await rows()).toEqual([
      { end: '1993-12-31', period_type: 'Q', report_date: '1993-12-31', report_time: 'unknown', eps: null, revenue_estimate: null, cur: 'USD', rep: true },
      { end: '2026-06-30', period_type: 'Q', report_date: '2026-07-30', report_time: 'before_market', eps: '1.88', revenue_estimate: null, cur: 'USD', rep: true },
      { end: '2026-09-30', period_type: 'Q', report_date: '2026-11-02', report_time: 'after_market', eps: null, revenue_estimate: null, cur: null, rep: false },
    ]);
    expect((await pool.query('SELECT DISTINCT security_id FROM earnings')).rows).toEqual([{ security_id: security }]);
    expect(await count('data_quality_finding')).toBe(0);
  });

  test('idempotente; mientras es futura se actualiza en sitio; al reportarse se consolida y queda congelada', async () => {
    await makeStock('EAB.US');
    await fundamentals('EAB.US', body({ Earnings: { History: hist() } }));
    await replay();
    expect((await replay({ all: true })).fundamentals).toMatchObject({ earningsInserted: 0, earningsUpdated: 0, earningsUnchanged: 3 });
    // la fecha de reporte se mueve y el proveedor ya trae la divisa y el estimado de la futura
    await fundamentals('EAB.US', body({ Earnings: { History: hist({ '2026-09-30': { reportDate: '2026-11-05', date: '2026-09-30', beforeAfterMarket: 'AfterMarket', currency: 'USD', epsActual: null, epsEstimate: 2.01 } }) } }));
    let out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ earningsInserted: 0, earningsUpdated: 1, earningsUnchanged: 2 });
    expect((await rows())[2]).toMatchObject({ report_date: '2026-11-05', eps: '2.01', cur: 'USD', rep: false });
    // se reporta: pasa a is_reported
    await fundamentals('EAB.US', body({ Earnings: { History: hist({ '2026-09-30': { reportDate: '2026-11-04', date: '2026-09-30', beforeAfterMarket: 'AfterMarket', currency: 'USD', epsActual: 2.05, epsEstimate: 1.99 } }) } }));
    out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ earningsUpdated: 1 });
    expect((await rows())[2]).toMatchObject({ report_date: '2026-11-04', eps: '1.99', rep: true });
    // ya reportada: un cambio posterior no la toca
    await fundamentals('EAB.US', body({ Earnings: { History: hist({ '2026-09-30': { reportDate: '2026-12-01', date: '2026-09-30', beforeAfterMarket: 'AfterMarket', currency: 'USD', epsActual: 2.05, epsEstimate: 1.5 } }) } }));
    out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ earningsUpdated: 0 });
    expect((await rows())[2]).toMatchObject({ report_date: '2026-11-04', eps: '1.99', rep: true });
  });

  test('un dato que llega vacío no borra el guardado; una fecha de periodo inválida se descarta con FUNDAMENTALS_INCOMPLETE', async () => {
    await makeStock('EAC.US');
    await fundamentals('EAC.US', body({ Earnings: { History: hist({ '2026-09-30': { reportDate: '2026-11-02', date: '2026-09-30', beforeAfterMarket: 'AfterMarket', currency: 'USD', epsActual: null, epsEstimate: 1.98 } }) } }));
    await replay();
    await fundamentals('EAC.US', body({ Earnings: { History: hist({ '2026-09-30': { reportDate: null, date: '2026-09-30', beforeAfterMarket: null, currency: null, epsActual: null, epsEstimate: 1.98 }, bad: { date: 'nope', reportDate: '2026-01-01' } }) } }));
    const out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ discarded: 1, earningsEstimateNoCurrency: 1 });
    expect((await rows())[2]).toMatchObject({ report_date: '2026-11-02', report_time: 'after_market', eps: '1.98', cur: 'USD' });
    expect((await findings('FUNDAMENTALS_INCOMPLETE'))[0]!.detail.items).toEqual([{ reason: 'earnings con fecha de periodo inválida', detail: { date: 'nope' } }]);
  });
});

describe('ANALYST_CONSENSUS, OWNERSHIP_SNAPSHOT y SHORT_INTEREST', () => {
  const ratings = (over: Record<string, unknown> = {}) => ({ Rating: 3.7955, TargetPrice: 328.0938, StrongBuy: 19, Buy: 6, Hold: 13, Sell: 3, StrongSell: 3, ...over });
  const stats = (over: Record<string, unknown> = {}) => ({ SharesOutstanding: 14594180000, SharesFloat: 14568786127, PercentInsiders: 1.648, PercentInstitutions: 66.325, SharesShort: null, SharesShortPriorMonth: null, ...over });

  test('consenso: rating_mean crudo y cinco recuentos; sin bolsa de EEUU el precio objetivo queda NULL (y se cuenta)', async () => {
    await makeStock('EAD.US');
    await fundamentals('EAD.US', body({ AnalystRatings: ratings() }));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ analystInserted: 1, analystTargetNoCurrency: 1, discarded: 0 });
    expect((await pool.query(
      'SELECT as_of_date::text AS d, rating_mean::text AS r, num_analysts, strong_buy, buy, hold, sell, strong_sell, target_mean, target_low, target_high, target_currency FROM analyst_consensus')).rows)
      .toEqual([{ d: '2026-10-12', r: '3.7955', num_analysts: null, strong_buy: 19, buy: 6, hold: 13, sell: 3, strong_sell: 3, target_mean: null, target_low: null, target_high: null, target_currency: null }]);
  });

  test('P17: el precio objetivo se guarda con General.CurrencyCode solo si el listing primario cotiza en EEUU; en Londres queda NULL', async () => {
    await makeStock('EAQ.US', 'XNAS');
    await makeStock('EAR.LSE', 'XLON');
    await fundamentals('EAQ.US', body({ AnalystRatings: ratings() }));
    await fundamentals('EAR.LSE', { ...body({ AnalystRatings: ratings() }), General: { Code: 'R', UpdatedAt: '2026-10-11', CurrencyCode: 'GBX' } });
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ analystInserted: 2, analystTargetNoCurrency: 1, discarded: 0 });
    expect((await pool.query('SELECT l.provider_symbol AS s, target_mean::text AS t, target_currency AS c FROM analyst_consensus a JOIN listing l USING (security_id) ORDER BY 1')).rows)
      .toEqual([{ s: 'EAQ.US', t: '328.0938', c: 'USD' }, { s: 'EAR.LSE', t: null, c: null }]);
  });

  test('5.6: la corrección del mismo día se aplica en silencio (analistas, ownership, short interest) y un dato vacío no borra el guardado', async () => {
    await makeStock('EAS.US', 'XNAS');
    const b = (r: Record<string, unknown>, st: Record<string, unknown>, tech: Record<string, unknown>) => body({ AnalystRatings: ratings(r), SharesStats: stats(st), Technicals: tech });
    await fundamentals('EAS.US', b({ TargetPrice: null }, {}, { SharesShort: 100, SharesShortPriorMonth: 90 }));
    await replay();
    // mismo día: el proveedor completa el objetivo, corrige el free float y el short interest
    await fundamentals('EAS.US', b({ TargetPrice: 330 }, { SharesFloat: 14000000000 }, { SharesShort: 110, SharesShortPriorMonth: null }));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ analystInserted: 0, analystUpdated: 1, ownershipSnapshotUpdated: 1, shortInterestUpdated: 1 });
    expect((await pool.query('SELECT target_mean::text AS t, target_currency AS c FROM analyst_consensus')).rows).toEqual([{ t: '330', c: 'USD' }]);
    expect((await pool.query('SELECT shares_float::text AS f FROM ownership_snapshot')).rows).toEqual([{ f: '14000000000' }]);
    expect((await pool.query('SELECT shares_short::text AS s, shares_short_prior_month::text AS p FROM short_interest')).rows).toEqual([{ s: '110', p: '90' }]); // el mes anterior vacío no borra
    expect(await count('data_quality_finding')).toBe(0);
  });

  test('deduplicado por valor: el mismo consenso otro día no inserta; si cambia, fila nueva con su fecha y la anterior se conserva', async () => {
    await makeStock('EAE.US');
    await fundamentals('EAE.US', body({ AnalystRatings: ratings() }));
    await replay();
    await fundamentals('EAE.US', body({ AnalystRatings: ratings({ TargetPrice: 330 }) }), '2026-10-13T10:00:00Z');
    expect((await replay()).fundamentals).toMatchObject({ analystInserted: 0 });
    await fundamentals('EAE.US', body({ AnalystRatings: ratings({ Rating: 3.8, Hold: 12 }) }), '2026-10-19T10:00:00Z');
    expect((await replay()).fundamentals).toMatchObject({ analystInserted: 1 });
    expect((await pool.query('SELECT as_of_date::text AS d, rating_mean::text AS r, hold FROM analyst_consensus ORDER BY 1')).rows).toEqual([{ d: '2026-10-12', r: '3.7955', hold: 13 }, { d: '2026-10-19', r: '3.8', hold: 12 }]);
  });

  test('recuento no entero: se descarta con FUNDAMENTALS_INCOMPLETE y el resto del consenso entra', async () => {
    await makeStock('EAF.US');
    await fundamentals('EAF.US', body({ AnalystRatings: ratings({ Hold: 1.5 }) }));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ analystInserted: 1, discarded: 1 });
    expect((await pool.query('SELECT hold, buy FROM analyst_consensus')).rows).toEqual([{ hold: null, buy: 6 }]);
  });

  test('ownership agregada con as_of_date = General.UpdatedAt, deduplicada por valor', async () => {
    await makeStock('EAG.US');
    await fundamentals('EAG.US', body({ SharesStats: stats() }));
    expect((await replay()).fundamentals).toMatchObject({ ownershipSnapshotInserted: 1 });
    await fundamentals('EAG.US', { ...body({ SharesStats: stats() }), General: { Code: 'X', UpdatedAt: '2026-10-18' } }, '2026-10-19T10:00:00Z');
    expect((await replay()).fundamentals).toMatchObject({ ownershipSnapshotInserted: 0 });
    await fundamentals('EAG.US', { ...body({ SharesStats: stats({ PercentInsiders: 1.7 }) }), General: { Code: 'X', UpdatedAt: '2026-10-25' } }, '2026-10-26T10:00:00Z');
    expect((await replay()).fundamentals).toMatchObject({ ownershipSnapshotInserted: 1 });
    expect((await pool.query('SELECT as_of_date::text AS d, shares_float::text AS f, percent_insiders::text AS pi, percent_institutions::text AS pn FROM ownership_snapshot ORDER BY 1')).rows)
      .toEqual([{ d: '2026-10-11', f: '14568786127', pi: '1.648', pn: '66.325' }, { d: '2026-10-25', f: '14568786127', pi: '1.7', pn: '66.325' }]);
  });

  test('ownership sin General.UpdatedAt válido no se escribe y deja rastro', async () => {
    await makeStock('EAH.US');
    await fundamentals('EAH.US', { General: { Code: 'X' }, SharesStats: stats() });
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ ownershipSnapshotInserted: 0, discarded: 1 });
    expect(await count('ownership_snapshot')).toBe(0);
  });

  test('short interest: SharesStats viene null, el valor está en Technicals; as_of_date = día de captura, deduplicado por shares_short; sin dato se cuenta como no disponible', async () => {
    await makeStock('EAI.US');
    const tech = (short: unknown) => ({ SharesShort: short, SharesShortPriorMonth: 128753092, ShortRatio: 2.82 });
    await fundamentals('EAI.US', body({ SharesStats: stats(), Technicals: tech(120763539) }));
    expect((await replay()).fundamentals).toMatchObject({ shortInterestInserted: 1, shortInterestUnavailable: 0 });
    await fundamentals('EAI.US', body({ SharesStats: stats(), Technicals: tech(120763539) }), '2026-10-13T10:00:00Z');
    expect((await replay()).fundamentals).toMatchObject({ shortInterestInserted: 0 });
    await fundamentals('EAI.US', body({ SharesStats: stats(), Technicals: tech(121000000) }), '2026-10-27T10:00:00Z');
    expect((await replay()).fundamentals).toMatchObject({ shortInterestInserted: 1 });
    expect((await pool.query('SELECT as_of_date::text AS d, settlement_date, shares_short::text AS s, shares_short_prior_month::text AS p FROM short_interest ORDER BY 1')).rows)
      .toEqual([{ d: '2026-10-12', settlement_date: null, s: '120763539', p: '128753092' }, { d: '2026-10-27', settlement_date: null, s: '121000000', p: '128753092' }]);
    await makeStock('EAJ.US');
    await fundamentals('EAJ.US', body({ SharesStats: stats(), Technicals: { Beta: 1 } }));
    expect((await replay()).fundamentals).toMatchObject({ shortInterestInserted: 0, shortInterestUnavailable: 1 });
  });
});

describe('HOLDER_POSITION e INSIDER_TRANSACTION', () => {
  const holders = (inst: Record<string, unknown>[] = [], funds: Record<string, unknown>[] = []) => ({ Institutions: Object.fromEntries(inst.map((h, i) => [String(i), h])), Funds: Object.fromEntries(funds.map((h, i) => [String(i), h])) });
  const h = (name: string, over: Record<string, unknown> = {}) => ({ name, date: '2026-06-30', totalShares: 7.9689, totalAssets: 5.0007, currentShares: 1162996939, change: 18301514, change_p: 1.5988, ...over });

  test('instituciones y fondos: holder_ref NULL, as_of_date = fecha de la posición, peso = totalAssets; idempotente', async () => {
    const { security } = await makeStock('EAK.US');
    await fundamentals('EAK.US', body({ Holders: holders([h('BlackRock Inc')], [h('Vanguard MStar Total Stk Mkt Idx Invest', { date: '2026-08-31', currentShares: 466773438, totalAssets: 6.3032 })]) }));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ holdersInserted: 2, holdersUpdated: 0, holdersExisting: 0, discarded: 0 });
    expect((await pool.query('SELECT holder_ref, holder_name, holder_type, as_of_date::text AS d, shares_held::text AS s, portfolio_weight_pct::text AS w FROM holder_position ORDER BY holder_type DESC')).rows).toEqual([
      { holder_ref: null, holder_name: 'BlackRock Inc', holder_type: 'institution', d: '2026-06-30', s: '1162996939', w: '5.0007' },
      { holder_ref: null, holder_name: 'Vanguard MStar Total Stk Mkt Idx Invest', holder_type: 'fund', d: '2026-08-31', s: '466773438', w: '6.3032' },
    ]);
    expect((await pool.query('SELECT DISTINCT security_id FROM holder_position')).rows).toEqual([{ security_id: security }]);
    expect((await replay({ all: true })).fundamentals).toMatchObject({ holdersInserted: 0, holdersExisting: 2 });
    expect(await count('holder_position')).toBe(2);
  });

  test('el nombre se compara normalizado (otra forma del mismo nombre, misma fecha = misma posición); una fecha nueva es una fila nueva; el número distinto en la misma clave se corrige en silencio (gana la última lectura)', async () => {
    await makeStock('EAL.US');
    await fundamentals('EAL.US', body({ Holders: holders([h('BlackRock Inc')]) }));
    await replay();
    await fundamentals('EAL.US', body({ Holders: holders([h('BlackRock, Inc.', { currentShares: 1 })]) }), '2026-10-13T10:00:00Z');
    let out = await replay();
    expect(out.fundamentals).toMatchObject({ holdersInserted: 0, holdersUpdated: 1, holdersExisting: 0 });
    expect((await pool.query('SELECT holder_name AS n, shares_held::text AS s FROM holder_position')).rows).toEqual([{ n: 'BlackRock, Inc.', s: '1' }]);
    expect(await count('data_quality_finding')).toBe(0);
    await fundamentals('EAL.US', body({ Holders: holders([h('BlackRock, Inc.', { date: '2026-09-30', currentShares: 1200000000 })]) }), '2026-10-27T10:00:00Z');
    out = await replay();
    expect(out.fundamentals).toMatchObject({ holdersInserted: 1 });
    expect((await pool.query('SELECT as_of_date::text AS d, shares_held::text AS s FROM holder_position ORDER BY 1')).rows).toEqual([{ d: '2026-06-30', s: '1' }, { d: '2026-09-30', s: '1200000000' }]);
  });

  test('holder sin nombre, fecha o acciones: no se crea y FUNDAMENTALS_INCOMPLETE guarda el motivo; HOLDER_UNMAPPED está apagada y no se emite', async () => {
    await makeStock('EAM.US');
    await fundamentals('EAM.US', body({ Holders: holders([h('Bien'), h('Sin acciones', { currentShares: null }), h('Sin fecha', { date: null })]) }));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ holdersInserted: 1, discarded: 2 });
    expect(await findings('HOLDER_UNMAPPED')).toHaveLength(0);
    expect((await pool.query("SELECT enabled FROM validation_rule WHERE rule_code = 'HOLDER_UNMAPPED'")).rows).toEqual([{ enabled: false }]);
    expect((await findings('FUNDAMENTALS_INCOMPLETE'))[0]!.detail.items.map((x: { reason: string }) => x.reason)).toEqual(['holder sin nombre, fecha o acciones', 'holder sin nombre, fecha o acciones']);
  });

  const tx = (name: string, over: Record<string, unknown> = {}) => ({ date: '2026-03-30', ownerCik: null, ownerName: name, transactionDate: '2026-03-30', transactionCode: 'S', transactionAmount: 25809, transactionPrice: 359.33, transactionAcquiredDisposed: 'D', postTransactionAmount: null, secLink: 'http://x', ...over });
  const insiders = (...t: Record<string, unknown>[]) => Object.fromEntries(t.map((x, i) => [String(i), x]));

  test('insiders: sin provider_txn_id, dedup por la clave de fallback; idempotente', async () => {
    await makeStock('EAN.US');
    await fundamentals('EAN.US', body({ InsiderTransactions: insiders(tx('Ana'), tx('Ana', { transactionCode: 'P', transactionAmount: 100 }), tx('Ana')) }));
    const out = await replay();
    expect(out.fundamentals).toMatchObject({ insidersInserted: 2, insidersExisting: 1, discarded: 0 });
    expect((await pool.query('SELECT provider_txn_id, insider_name, transaction_date::text AS d, transaction_code AS c, shares_transacted::text AS n, price_per_share::text AS p, shares_owned_after, relationship, acquired_disposed AS ad FROM insider_transaction ORDER BY transaction_code')).rows).toEqual([
      { provider_txn_id: null, insider_name: 'Ana', d: '2026-03-30', c: 'P', n: '100', p: '359.33', shares_owned_after: null, relationship: null, ad: 'D' },
      { provider_txn_id: null, insider_name: 'Ana', d: '2026-03-30', c: 'S', n: '25809', p: '359.33', shares_owned_after: null, relationship: null, ad: 'D' },
    ]);
    expect((await replay({ all: true })).fundamentals).toMatchObject({ insidersInserted: 0, insidersExisting: 3 });
    expect(await count('insider_transaction')).toBe(2);
  });

  test('5.6: transacción sin transactionAmount (laguna sistemática, filas sin secLink): no se crea, se cuenta y NO hay finding; el sentido A/D se guarda tal cual', async () => {
    await makeStock('EAO.US');
    await fundamentals('EAO.US', body({ InsiderTransactions: insiders(tx('Ana', { transactionCode: 'M', transactionAcquiredDisposed: 'A' }), tx('Ro', { transactionCode: 'P', transactionAmount: null, secLink: null })) }));
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
    expect(out.fundamentals).toMatchObject({ insidersInserted: 1, insidersNoAmount: 1, discarded: 0 });
    expect(await count('data_quality_finding')).toBe(0);
    expect((await pool.query('SELECT transaction_code AS c, acquired_disposed AS ad FROM insider_transaction')).rows).toEqual([{ c: 'M', ad: 'A' }]);
  });

  test('5.6: misma transacción con otro precio u otro sentido: gana la última lectura; un dato vacío no borra el guardado', async () => {
    await makeStock('EAT.US');
    await fundamentals('EAT.US', body({ InsiderTransactions: insiders(tx('Ana')) }));
    await replay();
    await fundamentals('EAT.US', body({ InsiderTransactions: insiders(tx('Ana', { transactionPrice: 360, transactionAcquiredDisposed: null, postTransactionAmount: 5000 })) }));
    const out = await replay({ all: true });
    expect(out.fundamentals).toMatchObject({ insidersInserted: 0, insidersUpdated: 1 });
    expect((await pool.query('SELECT price_per_share::text AS p, shares_owned_after::text AS a, acquired_disposed AS ad FROM insider_transaction')).rows).toEqual([{ p: '360', a: '5000', ad: 'D' }]);
  });

  test('un InsiderTransactions vacío ({}) no escribe nada ni falla', async () => {
    await makeStock('EAP.US');
    await fundamentals('EAP.US', body({ InsiderTransactions: {}, Holders: {} }));
    const out = await replay();
    expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
    expect(await count('insider_transaction')).toBe(0);
  });
});
