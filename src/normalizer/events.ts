import { withActor } from '../db/withActor.js';
import { emitFinding } from './findings.js';

// Escritores de eventos corporativos (decisiones-modelo.md §5.1-5.5): div/{symbol} -> DIVIDEND y splits/{symbol} -> STOCK_SPLIT.
// Ambos cuelgan de SECURITY: el listing se localiza por provider_symbol y se usa su security. Clave natural
// UNIQUE (security_id, ex_date). Un evento ya guardado que llega con otro valor se ACTUALIZA y emite CORPORATE_EVENT_CHANGED
// {old, new} (si ya hay uno abierto se conserva el old del primero); los metadatos (period y fechas de dividendo) se
// actualizan sin finding. Idempotentes. Devuelven null si el listing todavía no existe: el payload se queda pendiente.
// Solo cuenta el listing PRIMARIO (§5.5, D11 sustituida): un payload de otro listing de la misma security se salta (se cuenta en
// skippedNonPrimary). Lo que se descarta deja rastro: CORPORATE_EVENT_INCOMPLETE (dividendo sin importe o divisa, split con ratio
// ilegible, fecha inválida) y DIVIDEND_SAME_EX_DATE / SPLIT_SAME_EX_DATE (misma fecha ex con valores distintos), todos sobre
// el raw_payload.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v: unknown): string | null => (typeof v === 'string' && DATE.test(v) ? v : null);
const num = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export interface DividendRecord {
  date?: string | null;
  declarationDate?: string | null;
  recordDate?: string | null;
  paymentDate?: string | null;
  period?: string | null;
  value?: string | number | null; // ajustado por splits: NO se guarda
  unadjustedValue?: string | number | null;
  currency?: string | null;
}

export interface SplitRecord { date?: string | null; split?: string | null }

export interface EventsInput<R> {
  rawPayloadId: string;
  runId: string;
  symbol: string;
  records: R[];
}

export interface EventsSummary {
  payloads: number;
  rows: number;
  inserted: number;
  unchanged: number;
  changed: number; // valor corregido por el proveedor: se actualiza y se emite CORPORATE_EVENT_CHANGED
  metaUpdated: number; // solo cambió algún metadato (period, fechas): se actualiza sin finding
  skippedBadDate: number;
  skippedNoValue: number; // dividendo sin unadjustedValue o currency / split con ratio ilegible (CORPORATE_EVENT_INCOMPLETE)
  skippedSameExDate: number; // filas de fechas repetidas con valores distintos: no se escriben (DIVIDEND_/SPLIT_SAME_EX_DATE)
  skippedNonPrimary: number; // payload de un listing que no es el primario de su security: se marca leído y se salta
}

export const emptyEventsSummary = (): EventsSummary => ({ payloads: 0, rows: 0, inserted: 0, unchanged: 0, changed: 0, metaUpdated: 0, skippedBadDate: 0, skippedNoValue: 0, skippedSameExDate: 0, skippedNonPrimary: 0 });

async function listingOf(c: import('pg').PoolClient, symbol: string): Promise<{ securityId: string; primary: boolean } | null> {
  const r = (await c.query<{ id: string; primary: boolean }>('SELECT security_id AS id, is_primary_listing AS "primary" FROM listing WHERE provider_symbol = $1', [symbol])).rows[0];
  return r ? { securityId: r.id, primary: r.primary } : null;
}

type Discarded = { reason: string; row: unknown };
async function emitIncomplete(c: import('pg').PoolClient, input: { rawPayloadId: string; runId: string; symbol: string }, discarded: Discarded[]) {
  if (!discarded.length) return;
  await emitFinding(c, {
    ruleCode: 'CORPORATE_EVENT_INCOMPLETE', targetTable: 'raw_payload', targetKey: { raw_payload_id: Number(input.rawPayloadId) },
    detail: { provider_symbol: input.symbol, rows: discarded }, detectedByRun: input.runId,
  });
}

export async function writeDividends(input: EventsInput<DividendRecord>): Promise<EventsSummary | null> {
  return withActor('normalizer', `dividendos desde raw_payload ${input.rawPayloadId}`, async (c) => {
    const listing = await listingOf(c, input.symbol);
    if (!listing) return null;
    const securityId = listing.securityId;
    const s = emptyEventsSummary();
    s.payloads = 1;
    if (!listing.primary) { s.skippedNonPrimary = 1; return s; }
    const discarded: Discarded[] = [];

    // Se agrupa por fecha ex: dos o más filas para la misma fecha no caben en la clave y esa fecha no se escribe.
    const byDate = new Map<string, DividendRecord[]>();
    for (const r of input.records) {
      s.rows++;
      const d = date(r.date);
      if (!d) { s.skippedBadDate++; discarded.push({ reason: 'fecha inválida', row: r }); continue; }
      byDate.set(d, [...(byDate.get(d) ?? []), r]);
    }
    const a = { ex: [] as string[], decl: [] as (string | null)[], rec: [] as (string | null)[], pay: [] as (string | null)[], period: [] as (string | null)[], amount: [] as string[], cur: [] as string[] };
    const clashes: { ex_date: string; rows: DividendRecord[] }[] = [];
    for (const [d, rows] of byDate) {
      if (rows.length > 1) { s.skippedSameExDate += rows.length; clashes.push({ ex_date: d, rows }); continue; }
      const r = rows[0]!;
      const amount = num(r.unadjustedValue);
      const cur = typeof r.currency === 'string' && r.currency !== '' ? r.currency : null;
      if (amount === null || cur === null) { s.skippedNoValue++; discarded.push({ reason: amount === null ? 'sin unadjustedValue' : 'sin currency', row: r }); continue; }
      a.ex.push(d); a.decl.push(date(r.declarationDate)); a.rec.push(date(r.recordDate)); a.pay.push(date(r.paymentDate));
      a.period.push(num(r.period)); a.amount.push(amount); a.cur.push(cur);
    }
    if (clashes.length) {
      await emitFinding(c, {
        ruleCode: 'DIVIDEND_SAME_EX_DATE', targetTable: 'raw_payload', targetKey: { raw_payload_id: Number(input.rawPayloadId) },
        detail: { provider_symbol: input.symbol, dates: clashes }, detectedByRun: input.runId,
      });
    }
    await emitIncomplete(c, input, discarded);
    if (!a.ex.length) return s;

    const incoming = `unnest($2::date[], $3::date[], $4::date[], $5::date[], $6::text[], $7::numeric[], $8::text[]) AS i(ex_date, declaration_date, record_date, payment_date, period, amount_native, currency)`;
    const args = [securityId, a.ex, a.decl, a.rec, a.pay, a.period, a.amount, a.cur];
    const ins = await c.query(
      `INSERT INTO dividend (security_id, ex_date, declaration_date, record_date, payment_date, period, amount_native, currency)
       SELECT $1::bigint, i.ex_date, i.declaration_date, i.record_date, i.payment_date, i.period, i.amount_native, i.currency FROM ${incoming}
       ON CONFLICT (security_id, ex_date) DO NOTHING`, args);
    s.inserted = ins.rowCount ?? 0;

    const diff = await c.query<{ id: string; old: unknown; new: unknown; value_changed: boolean }>(
      `SELECT d.dividend_id AS id,
              jsonb_build_object('amount_native', d.amount_native, 'currency', d.currency) AS old,
              jsonb_build_object('amount_native', i.amount_native, 'currency', i.currency) AS new,
              (d.amount_native, d.currency) IS DISTINCT FROM (i.amount_native, i.currency) AS value_changed
       FROM ${incoming} JOIN dividend d ON d.security_id = $1::bigint AND d.ex_date = i.ex_date
       WHERE (d.amount_native, d.currency, d.period, d.declaration_date, d.record_date, d.payment_date)
             IS DISTINCT FROM (i.amount_native, i.currency, i.period, i.declaration_date, i.record_date, i.payment_date)
       ORDER BY i.ex_date`, args);
    if (diff.rowCount) {
      await c.query(
        `UPDATE dividend d SET declaration_date = i.declaration_date, record_date = i.record_date, payment_date = i.payment_date,
                               period = i.period, amount_native = i.amount_native, currency = i.currency
         FROM ${incoming} WHERE d.security_id = $1::bigint AND d.ex_date = i.ex_date
           AND (d.amount_native, d.currency, d.period, d.declaration_date, d.record_date, d.payment_date)
               IS DISTINCT FROM (i.amount_native, i.currency, i.period, i.declaration_date, i.record_date, i.payment_date)`, args);
    }
    for (const r of diff.rows) {
      if (!r.value_changed) { s.metaUpdated++; continue; }
      s.changed++;
      await emitFinding(c, {
        ruleCode: 'CORPORATE_EVENT_CHANGED', targetTable: 'dividend', targetKey: { dividend_id: Number(r.id) },
        detail: { old: r.old, new: r.new }, detectedByRun: input.runId, keepFirstOld: true,
      });
    }
    s.unchanged = a.ex.length - s.inserted - diff.rows.length;
    return s;
  });
}

// "4.000000/1.000000" -> [numerador, denominador] como texto exacto; null si no son dos números positivos.
export function parseSplitRatio(v: unknown): { n: string; d: string } | null {
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
  if (!m || !(Number(m[1]) > 0) || !(Number(m[2]) > 0)) return null;
  return { n: m[1]!, d: m[2]! };
}

export async function writeSplits(input: EventsInput<SplitRecord>): Promise<EventsSummary | null> {
  return withActor('normalizer', `splits desde raw_payload ${input.rawPayloadId}`, async (c) => {
    const listing = await listingOf(c, input.symbol);
    if (!listing) return null;
    const securityId = listing.securityId;
    const s = emptyEventsSummary();
    s.payloads = 1;
    if (!listing.primary) { s.skippedNonPrimary = 1; return s; }
    const discarded: Discarded[] = [];

    const byDate = new Map<string, { n: string; d: string }[]>();
    for (const r of input.records) {
      s.rows++;
      const dt = date(r.date);
      if (!dt) { s.skippedBadDate++; discarded.push({ reason: 'fecha inválida', row: r }); continue; }
      const ratio = parseSplitRatio(r.split);
      if (!ratio) { s.skippedNoValue++; discarded.push({ reason: 'ratio ilegible', row: r }); continue; }
      byDate.set(dt, [...(byDate.get(dt) ?? []), ratio]);
    }
    const ex: string[] = [], num_: string[] = [], den: string[] = [];
    const clashes: { ex_date: string; rows: { split: string }[] }[] = [];
    for (const [dt, ratios] of byDate) {
      // varias filas iguales el mismo día se colapsan; si difieren no se elige una al azar
      const first = ratios[0]!;
      if (ratios.some((x) => Number(x.n) !== Number(first.n) || Number(x.d) !== Number(first.d))) {
        s.skippedSameExDate += ratios.length; clashes.push({ ex_date: dt, rows: ratios.map((x) => ({ split: `${x.n}/${x.d}` })) }); continue;
      }
      ex.push(dt); num_.push(first.n); den.push(first.d);
    }
    if (clashes.length) {
      await emitFinding(c, {
        ruleCode: 'SPLIT_SAME_EX_DATE', targetTable: 'raw_payload', targetKey: { raw_payload_id: Number(input.rawPayloadId) },
        detail: { provider_symbol: input.symbol, dates: clashes }, detectedByRun: input.runId,
      });
    }
    await emitIncomplete(c, input, discarded);
    if (!ex.length) return s;

    const incoming = `unnest($2::date[], $3::numeric[], $4::numeric[]) AS i(ex_date, split_numerator, split_denominator)`;
    const args = [securityId, ex, num_, den];
    const ins = await c.query(
      `INSERT INTO stock_split (security_id, ex_date, split_numerator, split_denominator)
       SELECT $1::bigint, i.ex_date, i.split_numerator, i.split_denominator FROM ${incoming} ON CONFLICT (security_id, ex_date) DO NOTHING`, args);
    s.inserted = ins.rowCount ?? 0;

    const diff = await c.query<{ id: string; old: unknown; new: unknown }>(
      `SELECT t.stock_split_id AS id,
              jsonb_build_object('split_numerator', t.split_numerator, 'split_denominator', t.split_denominator) AS old,
              jsonb_build_object('split_numerator', i.split_numerator, 'split_denominator', i.split_denominator) AS new
       FROM ${incoming} JOIN stock_split t ON t.security_id = $1::bigint AND t.ex_date = i.ex_date
       WHERE (t.split_numerator, t.split_denominator) IS DISTINCT FROM (i.split_numerator, i.split_denominator) ORDER BY i.ex_date`, args);
    if (diff.rowCount) {
      await c.query(
        `UPDATE stock_split t SET split_numerator = i.split_numerator, split_denominator = i.split_denominator
         FROM ${incoming} WHERE t.security_id = $1::bigint AND t.ex_date = i.ex_date
           AND (t.split_numerator, t.split_denominator) IS DISTINCT FROM (i.split_numerator, i.split_denominator)`, args);
    }
    for (const r of diff.rows) {
      s.changed++;
      await emitFinding(c, {
        ruleCode: 'CORPORATE_EVENT_CHANGED', targetTable: 'stock_split', targetKey: { stock_split_id: Number(r.id) },
        detail: { old: r.old, new: r.new }, detectedByRun: input.runId, keepFirstOld: true,
      });
    }
    s.unchanged = ex.length - s.inserted - diff.rows.length;
    return s;
  });
}
