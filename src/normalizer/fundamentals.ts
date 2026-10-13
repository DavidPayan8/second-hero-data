import type pg from 'pg';
import { withActor } from '../db/withActor.js';
import { PROVIDER } from '../eodhd/provider.js';
import { emitFinding } from './findings.js';
import { addDays, date, isObj, text, type Discarded } from './values.js';
import { emptyEarningsCounts, writeEarnings, type EarningsCounts } from './earnings.js';
import { isTrustedQuoteCurrencyCountry } from './currency-trust.js';
import { emptyOwnershipCounts, writeOwnership, type OwnershipCounts } from './ownership.js';

// Escritor de fundamentals/{symbol} (decisiones-modelo.md §2/§2.1, decisiones-modelo-etf.md, decisiones-modelo-taxonomia.md).
// Una respuesta, dos formas según el tipo de activo del listing (ASSET_TYPE.requires_company):
//  - Acción: FUNDAMENTALS (bitemporal, una fila por company, periodo, tipo y reported_at), SHARES_OUTSTANDING de la security y
//    sector/industria de la company vía SOURCE_SECTOR_MAP (sin mapeo: NULL + SECTOR_UNMAPPED), calendario de resultados (earnings.ts) y
//    ownership, analistas, holders, insiders y short interest (ownership.ts).
//  - ETF: ETF_PROFILE, ETF_SNAPSHOT, ETF_HOLDING y ETF_ALLOCATION de la security.
// Como div/splits, solo cuenta el listing PRIMARIO (un payload de otro listing de la misma security se salta y se cuenta).
// Devuelve null si el listing todavía no existe: el payload se queda pendiente. Todo es idempotente.

// ----------------------------------------------------------------------------------------------------------------------
// De qué campo de Financials sale cada línea de FUNDAMENTALS (decisiones-modelo.md §2.0, P14). ÚNICO sitio con esta tabla.
// capex es positivo = salida de caja, tal cual lo da el proveedor. total_debt es el total del proveedor
// (shortLongTermDebtTotal): NUNCA se rellena con short_term_debt + long_term_debt (no son la misma magnitud).
// ----------------------------------------------------------------------------------------------------------------------
export const LINE_MAP = {
  Income_Statement: { revenue: 'totalRevenue', gross_profit: 'grossProfit', ebitda: 'ebitda', operating_income: 'operatingIncome', net_income: 'netIncome' },
  Cash_Flow: { operating_cf: 'totalCashFromOperatingActivities', capex: 'capitalExpenditures' },
  Balance_Sheet: {
    total_debt: 'shortLongTermDebtTotal', short_term_debt: 'shortTermDebt', long_term_debt: 'longTermDebt', total_liabilities: 'totalLiab',
    cash: 'cash', total_equity: 'totalStockholderEquity', total_assets: 'totalAssets',
  },
} as const;
const LINES = Object.values(LINE_MAP).flatMap((m) => Object.keys(m));
const SECTIONS = Object.keys(LINE_MAP) as (keyof typeof LINE_MAP)[];

// Sin filing_date, reported_at = period_end + este desfase, marcado 'estimated' (PLAN.md Fase 3, punto 5.4). PROVISIONAL.
export const ESTIMATED_REPORT_LAG_DAYS = 45;


export interface FundamentalsInput {
  rawPayloadId: string;
  runId: string;
  symbol: string;
  fetchedDate: string; // día (UTC) de la captura: es el as_of_date de los snapshots del ETF
  body: unknown;
}

export interface FundamentalsSummary extends EarningsCounts, OwnershipCounts {
  payloads: number;
  skippedNonPrimary: number;
  periods: number;
  fundamentalsInserted: number;
  fundamentalsUnchanged: number;
  fundamentalsFilled: number; // misma clave con líneas antes NULL y ahora informadas: se completan en silencio
  fundamentalsRevised: number; // misma clave con una línea ya informada y distinta: UPDATE + FUNDAMENTALS_REVISED (P16)
  sharesInserted: number;
  sharesUnchanged: number;
  sharesRevised: number;
  discarded: number; // periodos o campos que no se pueden escribir (FUNDAMENTALS_INCOMPLETE)
  sectorMapped: number;
  sectorUnmapped: number;
  etfProfileChanged: number;
  etfSnapshotInserted: number;
  etfSnapshotNoCurrency: number; // aum sin divisa verificable (listing primario fuera de TRUSTED_QUOTE_CURRENCY_COUNTRIES): no se guarda
  etfHoldingsInserted: number;
  etfHoldingsUnchangedSets: number;
  etfHoldingsResolved: number; // constituent_security_id completado en un snapshot ya guardado
  etfAllocationInserted: number;
  etfAllocationUnchangedSets: number;
}
export const emptyFundamentalsSummary = (): FundamentalsSummary => ({
  payloads: 0, skippedNonPrimary: 0, periods: 0, fundamentalsInserted: 0, fundamentalsUnchanged: 0, fundamentalsFilled: 0, fundamentalsRevised: 0,
  sharesInserted: 0, sharesUnchanged: 0, sharesRevised: 0, discarded: 0, sectorMapped: 0, sectorUnmapped: 0, etfProfileChanged: 0, etfSnapshotInserted: 0, etfSnapshotNoCurrency: 0,
  etfHoldingsInserted: 0, etfHoldingsUnchangedSets: 0, etfHoldingsResolved: 0, etfAllocationInserted: 0, etfAllocationUnchangedSets: 0,
  ...emptyEarningsCounts(), ...emptyOwnershipCounts(),
});

export async function writeFundamentals(input: FundamentalsInput): Promise<FundamentalsSummary | null> {
  if (!isObj(input.body)) throw new Error('se esperaba un objeto');
  const body = input.body;
  return withActor('normalizer', `fundamentals desde raw_payload ${input.rawPayloadId}`, async (c) => {
    const l = (await c.query<{ security_id: string; primary: boolean; company_id: string | null; requires_company: boolean; country: string | null }>(
      `SELECT l.security_id, l.is_primary_listing AS "primary", s.company_id, a.requires_company, x.country_iso AS country
       FROM listing l JOIN security s USING (security_id) JOIN asset_type a USING (asset_type_id) LEFT JOIN exchange x ON x.exchange_id = l.exchange_id
       WHERE l.provider_symbol = $1`, [input.symbol])).rows[0];
    if (!l) return null;
    const s = emptyFundamentalsSummary();
    s.payloads = 1;
    if (!l.primary) { s.skippedNonPrimary = 1; return s; }
    const discarded: Discarded[] = [];
    if (l.requires_company) {
      if (!l.company_id) throw new Error(`${input.symbol}: security sin company`);
      await writeStock(c, input, body, l.security_id, l.company_id, l.country, s, discarded);
    } else {
      await writeEtf(c, input, body, l.security_id, l.country, s, discarded);
    }
    s.discarded = discarded.length;
    if (discarded.length) {
      await emitFinding(c, {
        ruleCode: 'FUNDAMENTALS_INCOMPLETE', targetTable: 'raw_payload', targetKey: { raw_payload_id: Number(input.rawPayloadId) },
        detail: { provider_symbol: input.symbol, items: discarded }, detectedByRun: input.runId,
      });
    }
    return s;
  });
}

// ---------------------------------------------------------------------------------------------------------------- acciones

async function writeStock(c: pg.PoolClient, input: FundamentalsInput, body: Record<string, unknown>, securityId: string, companyId: string, country: string | null, s: FundamentalsSummary, discarded: Discarded[]) {
  const general = isObj(body.General) ? body.General : {};
  await mapSector(c, input, companyId, text(general.Sector), text(general.Industry), s);

  // ---- FUNDAMENTALS: se fusionan los tres estados por (periodo, tipo)
  const fin = isObj(body.Financials) ? body.Financials : {};
  const rows: Record<string, unknown>[] = [];
  const reportedByQuarter = new Map<string, { at: string; source: string }>();
  for (const [per, type] of [['quarterly', 'Q'], ['yearly', 'A']] as const) {
    const bySection = SECTIONS.map((sec) => {
      const section = isObj(fin[sec]) ? fin[sec] : {};
      return { sec, currency: text(section.currency_symbol), periods: isObj(section[per]) ? section[per] : {} };
    });
    const ends = new Set<string>();
    for (const b of bySection) for (const k of Object.keys(b.periods)) ends.add(k);
    for (const end of [...ends].sort()) {
      if (!date(end)) { discarded.push({ reason: 'fecha de periodo inválida', detail: { period: per, key: end } }); continue; }
      const stmts = bySection.map((b) => ({ sec: b.sec, row: isObj(b.periods[end]) ? b.periods[end] : null, section: b }));
      // divisa de reporte: la del estado; si la fila no la trae, la del bloque (nunca la de cotización)
      const currency = stmts.map((x) => text(x.row?.currency_symbol)).find((x) => x) ?? bySection.map((b) => b.currency).find((x) => x) ?? null;
      if (!currency) { discarded.push({ reason: 'periodo sin divisa de reporte', detail: { period: per, end } }); continue; }
      // reported_at = la última filing_date de los estados del periodo: la fila solo está completa desde entonces (sin look-ahead)
      const filings = stmts.map((x) => date(x.row?.filing_date)).filter((x): x is string => !!x && x >= end).sort();
      const reportedAt = filings.length ? filings[filings.length - 1]! : addDays(end, ESTIMATED_REPORT_LAG_DAYS);
      const source = filings.length ? 'provider' : 'estimated';
      const row: Record<string, unknown> = { period_end: end, period_type: type, reported_at: reportedAt, reported_at_source: source, currency };
      for (const x of stmts) for (const [col, field] of Object.entries(LINE_MAP[x.sec])) row[col] = text(x.row?.[field]);
      rows.push(row);
      if (type === 'Q') reportedByQuarter.set(end, { at: reportedAt, source });
    }
  }
  s.periods = rows.length;
  if (rows.length) await upsertFundamentals(c, input, companyId, rows, s);

  // ---- SHARES_OUTSTANDING (por security). Solo la serie trimestral: la anual trae el año natural, no el cierre fiscal.
  const os = isObj(body.outstandingShares) ? body.outstandingShares : {};
  const q = isObj(os.quarterly) ? Object.values(os.quarterly) : Array.isArray(os.quarterly) ? os.quarterly : [];
  const sh: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const e of q) {
    if (!isObj(e)) continue;
    const end = date(e.dateFormatted), shares = text(e.shares);
    if (!end || shares === null) { discarded.push({ reason: 'acciones en circulación sin fecha o sin cifra', detail: e }); continue; }
    if (seen.has(end)) continue;
    seen.add(end);
    // fecha derivada de la filing_date del mismo periodo en Financials (provider_derived); si no hay, estimada
    const known = reportedByQuarter.get(end);
    sh.push(known && known.source === 'provider'
      ? { period_end: end, reported_at: known.at, reported_at_source: 'provider_derived', shares }
      : { period_end: end, reported_at: addDays(end, ESTIMATED_REPORT_LAG_DAYS), reported_at_source: 'estimated', shares });
  }
  if (sh.length) await upsertShares(c, input, securityId, sh, s);

  // ---- calendario de resultados, ownership, analistas y short interest: bloques del mismo payload, por security
  await writeEarnings(c, securityId, body.Earnings, s, discarded);
  await writeOwnership(c, securityId, body, input.fetchedDate, country, s, discarded);
}

async function mapSector(c: pg.PoolClient, input: FundamentalsInput, companyId: string, sector: string | null, industry: string | null, s: FundamentalsSummary) {
  if (!sector) return; // el proveedor no da sector: no hay nada que mapear
  // (sector, industria) exacto; si no, solo sector (provider_industry_label = '')
  const m = (await c.query<{ sector_id: string; industry_id: string | null }>(
    `SELECT sector_id, industry_id FROM source_sector_map WHERE provider = $1 AND provider_sector_label = $2 AND provider_industry_label IN ($3, '')
     ORDER BY (provider_industry_label = '') LIMIT 1`, [PROVIDER, sector, industry ?? ''])).rows[0];
  if (!m) {
    s.sectorUnmapped++;
    await emitFinding(c, { ruleCode: 'SECTOR_UNMAPPED', targetTable: 'company', targetKey: { company_id: Number(companyId) }, detail: { sector, industry }, detectedByRun: input.runId });
    return;
  }
  s.sectorMapped++;
  await c.query(
    `UPDATE company SET sector_id = $2, industry_id = $3 WHERE company_id = $1 AND (sector_id, industry_id) IS DISTINCT FROM ($2::bigint, $3::bigint)`, [companyId, m.sector_id, m.industry_id]);
}

async function upsertFundamentals(c: pg.PoolClient, input: FundamentalsInput, companyId: string, rows: Record<string, unknown>[], s: FundamentalsSummary) {
  const cols = ['period_end', 'period_type', 'reported_at', 'reported_at_source', 'currency', ...LINES];
  const rec = `jsonb_to_recordset($2::jsonb) AS i(period_end date, period_type char(1), reported_at date, reported_at_source text, currency text, ${LINES.map((x) => `${x} numeric`).join(', ')})`;
  const args = [companyId, JSON.stringify(rows)];
  const ins = await c.query(
    `INSERT INTO fundamentals (company_id, ${cols.join(', ')}) SELECT $1::bigint, ${cols.map((x) => `i.${x}`).join(', ')} FROM ${rec}
     ON CONFLICT (company_id, period_end, period_type, reported_at) DO NOTHING`, args);
  s.fundamentalsInserted += ins.rowCount ?? 0;

  // Misma clave ya guardada (misma filing_date), P16: línea NULL + ahora informada = se completa en silencio; línea informada y distinta =
  // corrección del proveedor: UPDATE + FUNDAMENTALS_REVISED (solo columnas cambiadas, old del primero). Una línea que llega vacía no borra el dato.
  const conflict = (x: string) => `(f.${x} IS NOT NULL AND i.${x} IS NOT NULL AND f.${x} <> i.${x})`;
  const fill = (x: string) => `(f.${x} IS NULL AND i.${x} IS NOT NULL)`;
  const diff = await c.query<{ id: string; f: Record<string, unknown>; i: Record<string, unknown>; changed: string[] }>(
    `SELECT f.fundamentals_id AS id, to_jsonb(f) AS f, to_jsonb(i) AS i,
            ARRAY_REMOVE(ARRAY[${['currency', ...LINES].map((x) => `CASE WHEN ${conflict(x)} THEN '${x}' END`).join(', ')}], NULL) AS changed,
            (${LINES.map(fill).join(' OR ')}) AS has_fill
     FROM ${rec} JOIN fundamentals f ON f.company_id = $1::bigint AND f.period_end = i.period_end AND f.period_type = i.period_type AND f.reported_at = i.reported_at
     WHERE ${['currency', ...LINES].map(conflict).join(' OR ')} OR ${LINES.map(fill).join(' OR ')}`, args);
  const total = rows.length;
  const filled = diff.rows.filter((r) => r.changed.length === 0).length;
  if (diff.rowCount) {
    await c.query(
      `UPDATE fundamentals f SET currency = i.currency, ${LINES.map((x) => `${x} = COALESCE(i.${x}, f.${x})`).join(', ')}
       FROM ${rec} WHERE f.company_id = $1::bigint AND f.period_end = i.period_end AND f.period_type = i.period_type AND f.reported_at = i.reported_at
         AND (${['currency', ...LINES].map(conflict).join(' OR ')} OR ${LINES.map(fill).join(' OR ')})`, args);
  }
  for (const r of diff.rows) {
    if (!r.changed.length) continue;
    s.fundamentalsRevised++;
    const pick = (o: Record<string, unknown>) => Object.fromEntries(r.changed.map((k) => [k, o[k]]));
    await emitFinding(c, {
      ruleCode: 'FUNDAMENTALS_REVISED', targetTable: 'fundamentals', targetKey: { fundamentals_id: Number(r.id) },
      detail: { old: pick(r.f), new: pick(r.i) }, detectedByRun: input.runId, keepFirstOld: true,
    });
  }
  s.fundamentalsFilled += filled;
  s.fundamentalsUnchanged += total - (ins.rowCount ?? 0) - diff.rows.length;
}

async function upsertShares(c: pg.PoolClient, input: FundamentalsInput, securityId: string, rows: Record<string, unknown>[], s: FundamentalsSummary) {
  const rec = `jsonb_to_recordset($2::jsonb) AS i(period_end date, reported_at date, reported_at_source text, shares numeric)`;
  const args = [securityId, JSON.stringify(rows)];
  const ins = await c.query(
    `INSERT INTO shares_outstanding (security_id, period_end, reported_at, reported_at_source, shares)
     SELECT $1::bigint, i.period_end, i.reported_at, i.reported_at_source, i.shares FROM ${rec} ON CONFLICT (security_id, period_end, reported_at) DO NOTHING`, args);
  const diff = await c.query<{ id: string; old: string; new: string }>(
    `SELECT t.shares_outstanding_id AS id, t.shares::text AS old, i.shares::text AS new
     FROM ${rec} JOIN shares_outstanding t ON t.security_id = $1::bigint AND t.period_end = i.period_end AND t.reported_at = i.reported_at
     WHERE t.shares <> i.shares`, args);
  if (diff.rowCount) {
    await c.query(
      `UPDATE shares_outstanding t SET shares = i.shares FROM ${rec}
       WHERE t.security_id = $1::bigint AND t.period_end = i.period_end AND t.reported_at = i.reported_at AND t.shares <> i.shares`, args);
  }
  for (const r of diff.rows) {
    await emitFinding(c, {
      ruleCode: 'FUNDAMENTALS_REVISED', targetTable: 'shares_outstanding', targetKey: { shares_outstanding_id: Number(r.id) },
      detail: { old: { shares: r.old }, new: { shares: r.new } }, detectedByRun: input.runId, keepFirstOld: true,
    });
  }
  s.sharesInserted += ins.rowCount ?? 0;
  s.sharesRevised += diff.rows.length;
  s.sharesUnchanged += rows.length - (ins.rowCount ?? 0) - diff.rows.length;
}

// ---------------------------------------------------------------------------------------------------------------- ETF

async function writeEtf(c: pg.PoolClient, input: FundamentalsInput, body: Record<string, unknown>, securityId: string, country: string | null, s: FundamentalsSummary, discarded: Discarded[]) {
  const general = isObj(body.General) ? body.General : {};
  const etf = isObj(body.ETF_Data) ? body.ETF_Data : null;
  if (!etf) { discarded.push({ reason: 'sin bloque ETF_Data', detail: null }); return; }

  // ---- ETF_PROFILE (dimensión mutable; el historial lo cubre DIMENSION_AUDIT). NetExpenseRatio en fracción.
  let expense = text(etf.NetExpenseRatio);
  if (expense !== null && !(Number(expense) >= 0 && Number(expense) < 0.1)) {
    discarded.push({ reason: 'NetExpenseRatio fuera de la guarda de unidades [0, 0.1)', detail: { NetExpenseRatio: expense } });
    expense = null;
  }
  const inception = date(etf.Inception_Date);
  const p = await c.query(
    `INSERT INTO etf_profile (security_id, issuer, inception_date, index_tracked, category, domicile, expense_ratio)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (security_id) DO UPDATE SET issuer = EXCLUDED.issuer, inception_date = EXCLUDED.inception_date, index_tracked = EXCLUDED.index_tracked,
       category = EXCLUDED.category, domicile = EXCLUDED.domicile, expense_ratio = EXCLUDED.expense_ratio
     WHERE (etf_profile.issuer, etf_profile.inception_date, etf_profile.index_tracked, etf_profile.category, etf_profile.domicile, etf_profile.expense_ratio)
       IS DISTINCT FROM (EXCLUDED.issuer, EXCLUDED.inception_date, EXCLUDED.index_tracked, EXCLUDED.category, EXCLUDED.domicile, EXCLUDED.expense_ratio)`,
    [securityId, text(etf.Company_Name), inception, text(etf.Index_Name), text(general.Category), text(etf.Domicile), expense]);
  s.etfProfileChanged = p.rowCount ?? 0;

  // ---- ETF_SNAPSHOT: TotalAssets no trae fecha ni divisa; as_of_date = día de captura. La divisa (General.CurrencyCode) solo se da
  // por buena si el listing primario cotiza en TRUSTED_QUOTE_CURRENCY_COUNTRIES (P15); fuera, aum y currency NULL: no hay fila (limitación del proveedor, sin finding).
  const aum = text(etf.TotalAssets), currency = text(general.CurrencyCode);
  if (aum !== null) {
    if (!isTrustedQuoteCurrencyCountry(country)) s.etfSnapshotNoCurrency = 1;
    else if (!currency) discarded.push({ reason: 'TotalAssets sin divisa (General.CurrencyCode ausente)', detail: { TotalAssets: aum } });
    else {
      const last = (await c.query<{ same: boolean }>(
        `SELECT (aum, nav, currency, shares_outstanding_etf) IS NOT DISTINCT FROM ($2::numeric, NULL::numeric, $3::text, NULL::numeric) AS same
         FROM etf_snapshot WHERE security_id = $1 ORDER BY as_of_date DESC LIMIT 1`, [securityId, aum, currency])).rows[0];
      if (!last?.same) {
        // misma clave (mismo día) con otro valor: gana la última lectura, en silencio (decisiones-modelo.md 5.6)
        const r = await c.query('INSERT INTO etf_snapshot (security_id, as_of_date, aum, currency) VALUES ($1, $2, $3, $4) ON CONFLICT (security_id, as_of_date) DO UPDATE SET aum = EXCLUDED.aum, currency = EXCLUDED.currency', [securityId, input.fetchedDate, aum, currency]);
        s.etfSnapshotInserted = r.rowCount ?? 0;
      }
    }
  }

  // ---- ETF_HOLDING: el proveedor identifica al constituyente por su símbolo; sin fecha, importe ni acciones
  const hold = isObj(etf.Holdings) ? etf.Holdings : {};
  const hs: string[] = [], hn: (string | null)[] = [], hw: string[] = [];
  for (const [sym, v] of Object.entries(hold)) {
    const w = isObj(v) ? text(v['Assets_%']) : null;
    if (w === null) { discarded.push({ reason: 'holding sin Assets_%', detail: { symbol: sym } }); continue; }
    hs.push(sym); hn.push(isObj(v) ? text(v.Name) : null); hw.push(w);
  }
  if (hs.length) await writeHoldings(c, securityId, input.fetchedDate, hs, hn, hw, s);

  // ---- ETF_ALLOCATION: sector, región, capitalización y clase de activo, siempre del proveedor
  const alloc: { dimension: string; bucket: string; weight: string }[] = [];
  const add = (dimension: string, block: unknown, field: string | null) => {
    if (!isObj(block)) return;
    for (const [bucket, v] of Object.entries(block)) {
      const w = field === null ? text(v) : isObj(v) ? text(v[field]) : null;
      if (w === null) { discarded.push({ reason: 'allocation sin peso', detail: { dimension, bucket } }); continue; }
      alloc.push({ dimension, bucket, weight: w });
    }
  };
  add('sector', etf.Sector_Weights, 'Equity_%');
  add('region', etf.World_Regions, 'Equity_%');
  add('market_cap', etf.Market_Capitalisation, null);
  add('asset_class', etf.Asset_Allocation, 'Net_Assets_%'); // el neto; largo y corto siguen en el payload crudo
  if (alloc.length) await writeAllocation(c, input, securityId, alloc, s);
}

async function writeHoldings(c: pg.PoolClient, securityId: string, asOf: string, syms: string[], names: (string | null)[], weights: string[], s: FundamentalsSummary) {
  const incoming = `unnest($2::text[], $3::text[], $4::numeric[]) AS i(sym, name, w)`;
  // ¿el conjunto es idéntico al último guardado? (símbolo y peso)
  const last = (await c.query<{ d: string | null }>('SELECT max(as_of_date)::text AS d FROM etf_holding WHERE security_id = $1', [securityId])).rows[0]!.d;
  if (last) {
    const dif = (await c.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM (SELECT sym, w FROM ${incoming} EXCEPT SELECT constituent_symbol, weight_pct FROM etf_holding WHERE security_id = $1 AND as_of_date = $5::date) a)
             + (SELECT count(*) FROM (SELECT constituent_symbol, weight_pct FROM etf_holding WHERE security_id = $1 AND as_of_date = $5::date EXCEPT SELECT sym, w FROM ${incoming}) b))::int AS n`,
      [securityId, syms, names, weights, last])).rows[0]!.n;
    if (dif === 0) {
      s.etfHoldingsUnchangedSets = 1;
      // el conjunto no cambia, pero la resolución a security puede haber mejorado desde entonces
      const r = await c.query(
        `UPDATE etf_holding h SET constituent_security_id = l.security_id FROM listing l
         WHERE h.security_id = $1 AND h.as_of_date = $2::date AND h.constituent_security_id IS NULL AND l.provider_symbol = h.constituent_symbol`, [securityId, last]);
      s.etfHoldingsResolved = r.rowCount ?? 0;
      return;
    }
  }
  const r = await c.query(
    `INSERT INTO etf_holding (security_id, as_of_date, constituent_security_id, constituent_symbol, constituent_name, weight_pct)
     SELECT $1::bigint, $5::date, l.security_id, i.sym, i.name, i.w FROM ${incoming} LEFT JOIN listing l ON l.provider_symbol = i.sym
     ON CONFLICT (security_id, as_of_date, (COALESCE('sym:' || constituent_symbol, 'isin:' || constituent_isin, 'name:' || constituent_name)))
     DO UPDATE SET weight_pct = EXCLUDED.weight_pct, constituent_name = EXCLUDED.constituent_name,
                   constituent_security_id = COALESCE(EXCLUDED.constituent_security_id, etf_holding.constituent_security_id)`,
    [securityId, syms, names, weights, asOf]);
  s.etfHoldingsInserted = r.rowCount ?? 0;
}

async function writeAllocation(c: pg.PoolClient, input: FundamentalsInput, securityId: string, alloc: { dimension: string; bucket: string; weight: string }[], s: FundamentalsSummary) {
  const dims = alloc.map((a) => a.dimension), buckets = alloc.map((a) => a.bucket), weights = alloc.map((a) => a.weight);
  const incoming = `unnest($2::text[], $3::text[], $4::numeric[]) AS i(dimension, bucket, w)`;
  const last = (await c.query<{ d: string | null }>('SELECT max(as_of_date)::text AS d FROM etf_allocation WHERE security_id = $1', [securityId])).rows[0]!.d;
  if (last) {
    const dif = (await c.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM (SELECT dimension, bucket, w FROM ${incoming} EXCEPT SELECT dimension, bucket, weight_pct FROM etf_allocation WHERE security_id = $1 AND as_of_date = $5::date) a)
             + (SELECT count(*) FROM (SELECT dimension, bucket, weight_pct FROM etf_allocation WHERE security_id = $1 AND as_of_date = $5::date EXCEPT SELECT dimension, bucket, w FROM ${incoming}) b))::int AS n`,
      [securityId, dims, buckets, weights, last])).rows[0]!.n;
    if (dif === 0) { s.etfAllocationUnchangedSets = 1; return; }
  }
  // sector_id solo con dimension = 'sector', por SOURCE_SECTOR_MAP (sector sin industria); sin mapeo, NULL + SECTOR_UNMAPPED
  const r = await c.query<{ dimension: string; bucket: string; sector_id: string | null }>(
    `INSERT INTO etf_allocation (security_id, as_of_date, dimension, bucket, sector_id, weight_pct, source)
     SELECT $1::bigint, $5::date, i.dimension, i.bucket,
            CASE WHEN i.dimension = 'sector' THEN (SELECT m.sector_id FROM source_sector_map m WHERE m.provider = $6 AND m.provider_sector_label = i.bucket AND m.provider_industry_label = '') END,
            i.w, 'provider' FROM ${incoming}
     ON CONFLICT (security_id, as_of_date, dimension, bucket) DO UPDATE SET weight_pct = EXCLUDED.weight_pct
     RETURNING dimension, bucket, sector_id`, [securityId, dims, buckets, weights, input.fetchedDate, PROVIDER]);
  s.etfAllocationInserted = r.rowCount ?? 0;
  for (const row of r.rows) {
    if (row.dimension !== 'sector') continue;
    if (row.sector_id) { s.sectorMapped++; continue; }
    s.sectorUnmapped++;
    await emitFinding(c, { ruleCode: 'SECTOR_UNMAPPED', targetTable: 'etf_allocation', targetKey: { security_id: Number(securityId), bucket: row.bucket }, detail: { bucket: row.bucket }, detectedByRun: input.runId });
  }
}
