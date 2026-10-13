import type pg from 'pg';
import { date, entries, intText, isObj, text, type Discarded } from './values.js';

// Ownership, analistas, short interest, holders e insiders (decisiones-modelo-ownership.md) desde los bloques SharesStats,
// Technicals, AnalystRatings, Holders e InsiderTransactions de fundamentals/{symbol}, por security. Verificado con AAPL, TSLA y
// AMZN (clave demo). Las filas que no se pueden crear (NOT NULL del modelo sin dato) se descartan y el motivo va a
// FUNDAMENTALS_INCOMPLETE, igual que el resto de lo que se descarta en este endpoint.
export interface OwnershipCounts {
  ownershipSnapshotInserted: number;
  analystInserted: number;
  analystTargetNoCurrency: number; // TargetPrice sin divisa en el payload: target_mean y target_currency quedan NULL (propuesta P17)
  shortInterestInserted: number;
  shortInterestUnavailable: number; // el payload no trae SharesShort
  holdersInserted: number;
  holdersExisting: number; // misma clave (holder, fecha) ya guardada: append-only, no se toca
  holdersConflicting: number; // de ellas, con otro número de acciones (no se corrige: la serie es append-only)
  insidersInserted: number;
  insidersExisting: number;
}
export const emptyOwnershipCounts = (): OwnershipCounts => ({
  ownershipSnapshotInserted: 0, analystInserted: 0, analystTargetNoCurrency: 0, shortInterestInserted: 0, shortInterestUnavailable: 0,
  holdersInserted: 0, holdersExisting: 0, holdersConflicting: 0, insidersInserted: 0, insidersExisting: 0,
});

export async function writeOwnership(c: pg.PoolClient, securityId: string, body: Record<string, unknown>, fetchedDate: string, counts: OwnershipCounts, discarded: Discarded[]) {
  const general = isObj(body.General) ? body.General : {};
  await writeOwnershipSnapshot(c, securityId, isObj(body.SharesStats) ? body.SharesStats : {}, date(general.UpdatedAt), counts, discarded);
  await writeAnalyst(c, securityId, body.AnalystRatings, fetchedDate, counts, discarded);
  await writeShortInterest(c, securityId, isObj(body.SharesStats) ? body.SharesStats : {}, isObj(body.Technicals) ? body.Technicals : {}, fetchedDate, counts);
  await writeHolders(c, securityId, body.Holders, counts, discarded);
  await writeInsiders(c, securityId, body.InsiderTransactions, counts, discarded);
}

// Snapshot-temporal con as_of_date = General.UpdatedAt (§3); deduplicado por valor contra la última fila.
async function writeOwnershipSnapshot(c: pg.PoolClient, securityId: string, stats: Record<string, unknown>, asOf: string | null, counts: OwnershipCounts, discarded: Discarded[]) {
  const float = text(stats.SharesFloat), insiders = text(stats.PercentInsiders), institutions = text(stats.PercentInstitutions);
  if (float === null && insiders === null && institutions === null) return;
  if (!asOf) { discarded.push({ reason: 'ownership sin General.UpdatedAt válido', detail: { UpdatedAt: null } }); return; }
  const last = (await c.query<{ same: boolean }>(
    `SELECT (shares_float, percent_insiders, percent_institutions) IS NOT DISTINCT FROM ($2::numeric, $3::numeric, $4::numeric) AS same
     FROM ownership_snapshot WHERE security_id = $1 ORDER BY as_of_date DESC LIMIT 1`, [securityId, float, insiders, institutions])).rows[0];
  if (last?.same) return;
  const r = await c.query(
    'INSERT INTO ownership_snapshot (security_id, as_of_date, shares_float, percent_insiders, percent_institutions) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (security_id, as_of_date) DO NOTHING',
    [securityId, asOf, float, insiders, institutions]);
  counts.ownershipSnapshotInserted += r.rowCount ?? 0;
}

// Consenso (§4): rating_mean tal cual (sin fijar dirección) y los cinco recuentos. AnalystRatings no trae divisa para TargetPrice y
// el modelo exige target_currency si hay precio objetivo: sin divisa, target_* NULL (nunca se supone). num_analysts no viene.
async function writeAnalyst(c: pg.PoolClient, securityId: string, ratings: unknown, asOf: string, counts: OwnershipCounts, discarded: Discarded[]) {
  if (!isObj(ratings)) return;
  const mean = text(ratings.Rating);
  const names = ['StrongBuy', 'Buy', 'Hold', 'Sell', 'StrongSell'] as const;
  const n = names.map((k) => intText(ratings[k]));
  names.forEach((k, i) => { if (n[i] === null && text(ratings[k]) !== null) discarded.push({ reason: 'recuento de analistas no entero', detail: { [k]: text(ratings[k]) } }); });
  if (text(ratings.TargetPrice) !== null) counts.analystTargetNoCurrency++;
  if (mean === null && n.every((x) => x === null)) return;
  const last = (await c.query<{ same: boolean }>(
    `SELECT (rating_mean, strong_buy, buy, hold, sell, strong_sell) IS NOT DISTINCT FROM ($2::numeric, $3::int, $4::int, $5::int, $6::int, $7::int) AS same
     FROM analyst_consensus WHERE security_id = $1 ORDER BY as_of_date DESC LIMIT 1`, [securityId, mean, ...n])).rows[0];
  if (last?.same) return;
  const r = await c.query(
    `INSERT INTO analyst_consensus (security_id, as_of_date, rating_mean, strong_buy, buy, hold, sell, strong_sell)
     VALUES ($1, $2, $3::numeric, $4::int, $5::int, $6::int, $7::int, $8::int) ON CONFLICT (security_id, as_of_date) DO NOTHING`, [securityId, asOf, mean, ...n]);
  counts.analystInserted += r.rowCount ?? 0;
}

// Short interest (§5): as_of_date = día de captura, settlement_date NULL (el proveedor no la da), deduplicado por shares_short.
// SharesStats.SharesShort viene null en las tres acciones de la demo; el valor está en Technicals.SharesShort (y el mes anterior en
// Technicals.SharesShortPriorMonth, solo fallback de arranque). Se usa el bloque de SharesStats si trae dato y, si no, el de Technicals.
async function writeShortInterest(c: pg.PoolClient, securityId: string, stats: Record<string, unknown>, technicals: Record<string, unknown>, asOf: string, counts: OwnershipCounts) {
  const block = text(stats.SharesShort) !== null ? stats : technicals;
  const short = text(block.SharesShort), prior = text(block.SharesShortPriorMonth);
  if (short === null) { counts.shortInterestUnavailable++; return; }
  const last = (await c.query<{ same: boolean }>(
    'SELECT shares_short = $2::numeric AS same FROM short_interest WHERE security_id = $1 ORDER BY as_of_date DESC LIMIT 1', [securityId, short])).rows[0];
  if (last?.same) return;
  const r = await c.query(
    'INSERT INTO short_interest (security_id, as_of_date, shares_short, shares_short_prior_month) VALUES ($1, $2, $3, $4) ON CONFLICT (security_id, as_of_date) DO NOTHING', [securityId, asOf, short, prior]);
  counts.shortInterestInserted += r.rowCount ?? 0;
}

// Holders (§2.b): EODHD no da id de filer, así que holder_ref queda NULL y la clave usa el nombre normalizado (HOLDER_UNMAPPED
// está apagada: sería un finding por fila). as_of_date = la fecha de la posición que da el proveedor (cada holder trae la suya).
// Append-only: una posición con la misma clave no se corrige.
async function writeHolders(c: pg.PoolClient, securityId: string, holders: unknown, counts: OwnershipCounts, discarded: Discarded[]) {
  if (!isObj(holders)) return;
  const rows: { name: string; type: string; d: string; shares: string; weight: string | null }[] = [];
  for (const [block, type] of [['Institutions', 'institution'], ['Funds', 'fund']] as const) {
    for (const h of entries(holders[block])) {
      if (!isObj(h)) continue;
      const name = text(h.name), d = date(h.date), shares = text(h.currentShares);
      if (!name || !d || shares === null) { discarded.push({ reason: 'holder sin nombre, fecha o acciones', detail: { block, name, date: text(h.date), currentShares: shares } }); continue; }
      rows.push({ name, type, d, shares, weight: text(h.totalAssets) });
    }
  }
  if (!rows.length) return;
  const args = [securityId, JSON.stringify(rows)];
  const rec = 'jsonb_to_recordset($2::jsonb) AS i(name text, type text, d date, shares numeric, weight numeric)';
  const ins = await c.query(
    `INSERT INTO holder_position (security_id, holder_name, holder_type, as_of_date, shares_held, portfolio_weight_pct)
     SELECT $1::bigint, i.name, i.type, i.d, i.shares, i.weight FROM ${rec}
     ON CONFLICT (security_id, (COALESCE(holder_ref, holder_name_norm(holder_name))), as_of_date) DO NOTHING`, args);
  const conflicting = (await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${rec} JOIN holder_position h ON h.security_id = $1::bigint AND COALESCE(h.holder_ref, holder_name_norm(h.holder_name)) = holder_name_norm(i.name)
       AND h.as_of_date = i.d WHERE h.shares_held <> i.shares`, args)).rows[0]!.n;
  counts.holdersInserted += ins.rowCount ?? 0;
  counts.holdersExisting += rows.length - (ins.rowCount ?? 0);
  counts.holdersConflicting += conflicting;
}

// Insiders (§2.c): sin id de transacción en el payload (secLink es por filing y a veces null), así que provider_txn_id NULL y dedup
// por la clave de fallback. shares_transacted es NOT NULL: una transacción sin transactionAmount no se crea (en la demo son filas sin
// secLink ni cantidad, 24 de 40 en TSLA y AMZN). El sentido (transactionAcquiredDisposed) no tiene columna (propuesta P18).
async function writeInsiders(c: pg.PoolClient, securityId: string, insiders: unknown, counts: OwnershipCounts, discarded: Discarded[]) {
  const rows: { name: string; d: string; code: string; shares: string; price: string | null; after: string | null }[] = [];
  for (const t of entries(insiders)) {
    if (!isObj(t)) continue;
    const name = text(t.ownerName), d = date(t.transactionDate), code = text(t.transactionCode), shares = text(t.transactionAmount);
    const missing = [!name && 'ownerName', !d && 'transactionDate', !code && 'transactionCode', shares === null && 'transactionAmount'].filter(Boolean);
    if (missing.length) { discarded.push({ reason: 'transacción de insider sin ' + missing.join(', '), detail: { ownerName: name, transactionDate: text(t.transactionDate), transactionCode: code } }); continue; }
    rows.push({ name: name!, d: d!, code: code!, shares: shares!, price: text(t.transactionPrice), after: text(t.postTransactionAmount) });
  }
  if (!rows.length) return;
  const r = await c.query(
    `INSERT INTO insider_transaction (security_id, insider_name, transaction_date, transaction_code, shares_transacted, price_per_share, shares_owned_after)
     SELECT $1::bigint, i.name, i.d, i.code, i.shares, i.price, i.after
     FROM jsonb_to_recordset($2::jsonb) AS i(name text, d date, code text, shares numeric, price numeric, after numeric)
     ON CONFLICT (security_id, insider_name, transaction_date, transaction_code, shares_transacted) WHERE provider_txn_id IS NULL DO NOTHING`, [securityId, JSON.stringify(rows)]);
  counts.insidersInserted += r.rowCount ?? 0;
  counts.insidersExisting += rows.length - (r.rowCount ?? 0);
}
