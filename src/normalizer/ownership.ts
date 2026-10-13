import type pg from 'pg';
import { isTrustedQuoteCurrencyCountry } from './currency-trust.js';
import { date, entries, intText, isObj, text, type Discarded } from './values.js';

// Ownership, analistas, short interest, holders e insiders (decisiones-modelo-ownership.md) desde los bloques SharesStats,
// Technicals, AnalystRatings, Holders e InsiderTransactions de fundamentals/{symbol}, por security. Verificado con AAPL, TSLA y
// AMZN (clave demo). Regla general de correcciones (decisiones-modelo.md 5.6): misma clave natural con otro valor = gana la última
// lectura (UPDATE); en las series por as_of_date, en silencio; NULL a valor se completa; un valor que llega vacío no borra el
// guardado. Una fila que no se puede crear por una laguna sistemática del proveedor (insider sin cantidad) se cuenta, sin finding;
// el resto de lo que se descarta va a FUNDAMENTALS_INCOMPLETE.
export interface OwnershipCounts {
  ownershipSnapshotInserted: number;
  ownershipSnapshotUpdated: number;
  analystInserted: number;
  analystUpdated: number;
  analystTargetNoCurrency: number; // TargetPrice sin divisa de confianza (listing primario fuera de TRUSTED_QUOTE_CURRENCY_COUNTRIES): target_* NULL
  shortInterestInserted: number;
  shortInterestUpdated: number;
  shortInterestUnavailable: number; // el payload no trae SharesShort
  holdersInserted: number;
  holdersUpdated: number; // misma clave (holder, fecha) con otras acciones o peso: gana la última lectura
  holdersExisting: number;
  insidersInserted: number;
  insidersUpdated: number;
  insidersExisting: number;
  insidersNoAmount: number; // sin transactionAmount: no se crean (laguna sistemática del proveedor, sin finding)
}
export const emptyOwnershipCounts = (): OwnershipCounts => ({
  ownershipSnapshotInserted: 0, ownershipSnapshotUpdated: 0, analystInserted: 0, analystUpdated: 0, analystTargetNoCurrency: 0,
  shortInterestInserted: 0, shortInterestUpdated: 0, shortInterestUnavailable: 0,
  holdersInserted: 0, holdersUpdated: 0, holdersExisting: 0, insidersInserted: 0, insidersUpdated: 0, insidersExisting: 0, insidersNoAmount: 0,
});

export async function writeOwnership(c: pg.PoolClient, securityId: string, body: Record<string, unknown>, fetchedDate: string, country: string | null, counts: OwnershipCounts, discarded: Discarded[]) {
  const general = isObj(body.General) ? body.General : {};
  await writeOwnershipSnapshot(c, securityId, isObj(body.SharesStats) ? body.SharesStats : {}, date(general.UpdatedAt), counts, discarded);
  await writeAnalyst(c, securityId, body.AnalystRatings, fetchedDate, isTrustedQuoteCurrencyCountry(country) ? text(general.CurrencyCode) : null, counts, discarded);
  await writeShortInterest(c, securityId, isObj(body.SharesStats) ? body.SharesStats : {}, isObj(body.Technicals) ? body.Technicals : {}, fetchedDate, counts);
  await writeHolders(c, securityId, body.Holders, counts, discarded);
  await writeInsiders(c, securityId, body.InsiderTransactions, counts, discarded);
}

// Contabiliza un upsert con RETURNING (xmax = 0): insertada o actualizada.
const tally = (rows: { inserted: boolean }[]) => ({ inserted: rows.filter((r) => r.inserted).length, updated: rows.filter((r) => !r.inserted).length });

// Snapshot-temporal con as_of_date = General.UpdatedAt (3); deduplicado por valor contra la última fila.
async function writeOwnershipSnapshot(c: pg.PoolClient, securityId: string, stats: Record<string, unknown>, asOf: string | null, counts: OwnershipCounts, discarded: Discarded[]) {
  const float = text(stats.SharesFloat), insiders = text(stats.PercentInsiders), institutions = text(stats.PercentInstitutions);
  if (float === null && insiders === null && institutions === null) return;
  if (!asOf) { discarded.push({ reason: 'ownership sin General.UpdatedAt válido', detail: { UpdatedAt: null } }); return; }
  const last = (await c.query<{ same: boolean }>(
    `SELECT (shares_float, percent_insiders, percent_institutions) IS NOT DISTINCT FROM ($2::numeric, $3::numeric, $4::numeric) AS same
     FROM ownership_snapshot WHERE security_id = $1 ORDER BY as_of_date DESC LIMIT 1`, [securityId, float, insiders, institutions])).rows[0];
  if (last?.same) return;
  const r = await c.query<{ inserted: boolean }>(
    `INSERT INTO ownership_snapshot (security_id, as_of_date, shares_float, percent_insiders, percent_institutions) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (security_id, as_of_date) DO UPDATE SET shares_float = COALESCE(EXCLUDED.shares_float, ownership_snapshot.shares_float),
       percent_insiders = COALESCE(EXCLUDED.percent_insiders, ownership_snapshot.percent_insiders), percent_institutions = COALESCE(EXCLUDED.percent_institutions, ownership_snapshot.percent_institutions)
     RETURNING (xmax = 0) AS inserted`, [securityId, asOf, float, insiders, institutions]);
  const t = tally(r.rows);
  counts.ownershipSnapshotInserted += t.inserted;
  counts.ownershipSnapshotUpdated += t.updated;
}

// Consenso (4): rating_mean tal cual (sin fijar dirección) y los cinco recuentos. AnalystRatings no trae divisa para TargetPrice:
// se toma General.CurrencyCode solo si el listing primario cotiza en un país de confianza (P17, `quoteCurrency` llega ya resuelta); si no,
// target_mean y target_currency NULL. num_analysts, target_low y target_high no vienen.
async function writeAnalyst(c: pg.PoolClient, securityId: string, ratings: unknown, asOf: string, quoteCurrency: string | null, counts: OwnershipCounts, discarded: Discarded[]) {
  if (!isObj(ratings)) return;
  const mean = text(ratings.Rating);
  const names = ['StrongBuy', 'Buy', 'Hold', 'Sell', 'StrongSell'] as const;
  const n = names.map((k) => intText(ratings[k]));
  names.forEach((k, i) => { if (n[i] === null && text(ratings[k]) !== null) discarded.push({ reason: 'recuento de analistas no entero', detail: { [k]: text(ratings[k]) } }); });
  let target = text(ratings.TargetPrice);
  if (target !== null && !quoteCurrency) { counts.analystTargetNoCurrency++; target = null; }
  const currency = target === null ? null : quoteCurrency;
  if (mean === null && n.every((x) => x === null) && target === null) return;
  const last = (await c.query<{ same: boolean }>(
    `SELECT (rating_mean, strong_buy, buy, hold, sell, strong_sell, target_mean, target_currency)
            IS NOT DISTINCT FROM ($2::numeric, $3::int, $4::int, $5::int, $6::int, $7::int, $8::numeric, $9::text) AS same
     FROM analyst_consensus WHERE security_id = $1 ORDER BY as_of_date DESC LIMIT 1`, [securityId, mean, ...n, target, currency])).rows[0];
  if (last?.same) return;
  const r = await c.query<{ inserted: boolean }>(
    `INSERT INTO analyst_consensus (security_id, as_of_date, rating_mean, strong_buy, buy, hold, sell, strong_sell, target_mean, target_currency)
     VALUES ($1, $2, $3::numeric, $4::int, $5::int, $6::int, $7::int, $8::int, $9::numeric, $10::text)
     ON CONFLICT (security_id, as_of_date) DO UPDATE SET
       rating_mean = COALESCE(EXCLUDED.rating_mean, analyst_consensus.rating_mean), strong_buy = COALESCE(EXCLUDED.strong_buy, analyst_consensus.strong_buy),
       buy = COALESCE(EXCLUDED.buy, analyst_consensus.buy), hold = COALESCE(EXCLUDED.hold, analyst_consensus.hold), sell = COALESCE(EXCLUDED.sell, analyst_consensus.sell),
       strong_sell = COALESCE(EXCLUDED.strong_sell, analyst_consensus.strong_sell),
       target_mean = COALESCE(EXCLUDED.target_mean, analyst_consensus.target_mean),
       target_currency = CASE WHEN EXCLUDED.target_mean IS NOT NULL THEN EXCLUDED.target_currency ELSE analyst_consensus.target_currency END
     RETURNING (xmax = 0) AS inserted`, [securityId, asOf, mean, ...n, target, currency]);
  const t = tally(r.rows);
  counts.analystInserted += t.inserted;
  counts.analystUpdated += t.updated;
}

// Short interest (5): as_of_date = día de captura, settlement_date NULL (el proveedor no la da), deduplicado por shares_short.
// SharesStats.SharesShort viene null en las tres acciones de la demo; el valor está en Technicals.SharesShort (y el mes anterior en
// Technicals.SharesShortPriorMonth, solo fallback de arranque). Se usa el bloque de SharesStats si trae dato y, si no, el de Technicals.
async function writeShortInterest(c: pg.PoolClient, securityId: string, stats: Record<string, unknown>, technicals: Record<string, unknown>, asOf: string, counts: OwnershipCounts) {
  const block = text(stats.SharesShort) !== null ? stats : technicals;
  const short = text(block.SharesShort), prior = text(block.SharesShortPriorMonth);
  if (short === null) { counts.shortInterestUnavailable++; return; }
  const last = (await c.query<{ same: boolean }>(
    'SELECT (shares_short, shares_short_prior_month) IS NOT DISTINCT FROM ($2::numeric, $3::numeric) AS same FROM short_interest WHERE security_id = $1 ORDER BY as_of_date DESC LIMIT 1', [securityId, short, prior])).rows[0];
  if (last?.same) return;
  const r = await c.query<{ inserted: boolean }>(
    `INSERT INTO short_interest (security_id, as_of_date, shares_short, shares_short_prior_month) VALUES ($1, $2, $3, $4)
     ON CONFLICT (security_id, as_of_date) DO UPDATE SET shares_short = EXCLUDED.shares_short,
       shares_short_prior_month = COALESCE(EXCLUDED.shares_short_prior_month, short_interest.shares_short_prior_month)
     RETURNING (xmax = 0) AS inserted`, [securityId, asOf, short, prior]);
  const t = tally(r.rows);
  counts.shortInterestInserted += t.inserted;
  counts.shortInterestUpdated += t.updated;
}

// Holders (2.b): EODHD no da id de filer, así que holder_ref queda NULL y la clave usa el nombre normalizado (HOLDER_UNMAPPED
// está apagada: sería un finding por fila). as_of_date = la fecha de la posición que da el proveedor (cada holder trae la suya).
// Misma clave con otro número de acciones: gana la última lectura (UPDATE en silencio, 5.6).
async function writeHolders(c: pg.PoolClient, securityId: string, holders: unknown, counts: OwnershipCounts, discarded: Discarded[]) {
  if (!isObj(holders)) return;
  const rows: { ord: number; name: string; type: string; d: string; shares: string; weight: string | null }[] = [];
  for (const [block, type] of [['Institutions', 'institution'], ['Funds', 'fund']] as const) {
    for (const h of entries(holders[block])) {
      if (!isObj(h)) continue;
      const name = text(h.name), d = date(h.date), shares = text(h.currentShares);
      if (!name || !d || shares === null) { discarded.push({ reason: 'holder sin nombre, fecha o acciones', detail: { block, name, date: text(h.date), currentShares: shares } }); continue; }
      rows.push({ ord: rows.length, name, type, d, shares, weight: text(h.totalAssets) });
    }
  }
  if (!rows.length) return;
  // Una sola fila por clave dentro del payload (la última): ON CONFLICT DO UPDATE no admite tocar dos veces la misma fila.
  const r = await c.query<{ inserted: boolean }>(
    `INSERT INTO holder_position (security_id, holder_name, holder_type, as_of_date, shares_held, portfolio_weight_pct)
     SELECT $1::bigint, k.name, k.type, k.d, k.shares, k.weight FROM (
       SELECT DISTINCT ON (holder_name_norm(i.name), i.d) i.* FROM jsonb_to_recordset($2::jsonb) AS i(ord int, name text, type text, d date, shares numeric, weight numeric)
       ORDER BY holder_name_norm(i.name), i.d, i.ord DESC) k
     ON CONFLICT (security_id, (COALESCE(holder_ref, holder_name_norm(holder_name))), as_of_date) DO UPDATE SET
       holder_name = EXCLUDED.holder_name, holder_type = EXCLUDED.holder_type, shares_held = EXCLUDED.shares_held,
       portfolio_weight_pct = COALESCE(EXCLUDED.portfolio_weight_pct, holder_position.portfolio_weight_pct)
     WHERE (holder_position.holder_name, holder_position.holder_type, holder_position.shares_held, holder_position.portfolio_weight_pct)
       IS DISTINCT FROM (EXCLUDED.holder_name, EXCLUDED.holder_type, EXCLUDED.shares_held, COALESCE(EXCLUDED.portfolio_weight_pct, holder_position.portfolio_weight_pct))
     RETURNING (xmax = 0) AS inserted`, [securityId, JSON.stringify(rows)]);
  const t = tally(r.rows);
  counts.holdersInserted += t.inserted;
  counts.holdersUpdated += t.updated;
  counts.holdersExisting += rows.length - t.inserted - t.updated;
}

// Insiders (2.c y 8): sin id de transacción en el payload (secLink es por filing y a veces null), así que provider_txn_id NULL y dedup
// por la clave de fallback. shares_transacted es NOT NULL: una transacción sin transactionAmount no se crea; es una laguna sistemática
// del proveedor (en la demo 24 de 40) y se cuenta, sin finding. El sentido va en acquired_disposed, tal cual (A/D, sin CHECK).
async function writeInsiders(c: pg.PoolClient, securityId: string, insiders: unknown, counts: OwnershipCounts, discarded: Discarded[]) {
  const rows: { ord: number; name: string; d: string; code: string; shares: string; price: string | null; after: string | null; ad: string | null }[] = [];
  for (const t of entries(insiders)) {
    if (!isObj(t)) continue;
    const name = text(t.ownerName), d = date(t.transactionDate), code = text(t.transactionCode), shares = text(t.transactionAmount);
    if (shares === null) { counts.insidersNoAmount++; continue; }
    const missing = [!name && 'ownerName', !d && 'transactionDate', !code && 'transactionCode'].filter(Boolean);
    if (missing.length) { discarded.push({ reason: 'transacción de insider sin ' + missing.join(', '), detail: { ownerName: name, transactionDate: text(t.transactionDate), transactionCode: code } }); continue; }
    rows.push({ ord: rows.length, name: name!, d: d!, code: code!, shares, price: text(t.transactionPrice), after: text(t.postTransactionAmount), ad: text(t.transactionAcquiredDisposed) });
  }
  if (!rows.length) return;
  const r = await c.query<{ inserted: boolean }>(
    `INSERT INTO insider_transaction (security_id, insider_name, transaction_date, transaction_code, shares_transacted, price_per_share, shares_owned_after, acquired_disposed)
     SELECT $1::bigint, k.name, k.d, k.code, k.shares, k.price, k.after, k.ad FROM (
       SELECT DISTINCT ON (i.name, i.d, i.code, i.shares) i.* FROM jsonb_to_recordset($2::jsonb) AS i(ord int, name text, d date, code text, shares numeric, price numeric, after numeric, ad text)
       ORDER BY i.name, i.d, i.code, i.shares, i.ord DESC) k
     ON CONFLICT (security_id, insider_name, transaction_date, transaction_code, shares_transacted) WHERE provider_txn_id IS NULL DO UPDATE SET
       price_per_share = COALESCE(EXCLUDED.price_per_share, insider_transaction.price_per_share),
       shares_owned_after = COALESCE(EXCLUDED.shares_owned_after, insider_transaction.shares_owned_after),
       acquired_disposed = COALESCE(EXCLUDED.acquired_disposed, insider_transaction.acquired_disposed)
     WHERE (insider_transaction.price_per_share, insider_transaction.shares_owned_after, insider_transaction.acquired_disposed)
       IS DISTINCT FROM (COALESCE(EXCLUDED.price_per_share, insider_transaction.price_per_share), COALESCE(EXCLUDED.shares_owned_after, insider_transaction.shares_owned_after), COALESCE(EXCLUDED.acquired_disposed, insider_transaction.acquired_disposed))
     RETURNING (xmax = 0) AS inserted`, [securityId, JSON.stringify(rows)]);
  const t = tally(r.rows);
  counts.insidersInserted += t.inserted;
  counts.insidersUpdated += t.updated;
  counts.insidersExisting += rows.length - t.inserted - t.updated;
}
