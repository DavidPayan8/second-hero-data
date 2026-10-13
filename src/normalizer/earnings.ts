import type pg from 'pg';
import { date, entries, isObj, text, type Discarded } from './values.js';

// Calendario de resultados (decisiones-modelo-earnings.md) desde Earnings.History de fundamentals/{symbol}.
// Una fila por (security, fin de periodo fiscal, 'Q'); hecho puntual mutable hasta consolidar: se actualiza en sitio mientras
// is_reported = false y queda congelada al reportarse. Verificado con AAPL, TSLA y AMZN (clave demo):
//  - la clave de History es el fin de periodo (`date`), que coincide con el de Financials trimestral (131 de 132 en AAPL; la que
//    falta es el trimestre aún sin reportar);
//  - eps_actual NO se guarda (se deriva de FUNDAMENTALS): epsActual solo decide is_reported;
//  - `currency` solo viene en las entradas ya reportadas; en la futura es null y NINGÚN otro campo la da (Trend tampoco; la divisa
//    de reporte de Financials o la de cotización serían suposiciones). Sin divisa, eps_estimate queda NULL y la fila de calendario
//    se escribe igual, sin finding (limitación sistemática del proveedor);
//  - revenue_estimate no sale de History; Earnings.Trend trae revenueEstimateAvg pero sin divisa y con otra definición que
//    epsEstimate, así que queda NULL;
//  - Earnings.Annual solo trae epsActual (nada que guardar).
export interface EarningsCounts {
  earningsInserted: number;
  earningsUpdated: number;
  earningsUnchanged: number; // incluye las filas ya reportadas (congeladas)
  earningsEstimateNoCurrency: number; // entradas con epsEstimate pero sin divisa: el estimado no se guarda
}
export const emptyEarningsCounts = (): EarningsCounts => ({ earningsInserted: 0, earningsUpdated: 0, earningsUnchanged: 0, earningsEstimateNoCurrency: 0 });

const REPORT_TIME: Record<string, string> = { BeforeMarket: 'before_market', AfterMarket: 'after_market' };

interface Row { end: string; report_date: string | null; report_time: string; eps: string | null; currency: string | null; reported: boolean }
const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Number(a) === Number(b));

export async function writeEarnings(c: pg.PoolClient, securityId: string, earnings: unknown, counts: EarningsCounts, discarded: Discarded[]) {
  const history = isObj(earnings) ? earnings.History : null;
  const incoming = new Map<string, Row>();
  for (const e of entries(history)) {
    if (!isObj(e)) continue;
    const end = date(e.date);
    if (!end) { discarded.push({ reason: 'earnings con fecha de periodo inválida', detail: { date: e.date ?? null } }); continue; }
    let eps = text(e.epsEstimate);
    const currency = text(e.currency);
    if (eps !== null && !currency) { counts.earningsEstimateNoCurrency++; eps = null; }
    incoming.set(end, {
      end, report_date: date(e.reportDate), report_time: REPORT_TIME[text(e.beforeAfterMarket) ?? ''] ?? 'unknown',
      eps, currency, reported: text(e.epsActual) !== null,
    });
  }
  if (!incoming.size) return;

  const stored = new Map((await c.query<{ end: string; report_date: string | null; report_time: string; eps: string | null; currency: string | null; reported: boolean }>(
    `SELECT fiscal_period_end::text AS "end", report_date::text AS report_date, report_time, eps_estimate::text AS eps, estimate_currency AS currency, is_reported AS reported
     FROM earnings WHERE security_id = $1 AND period_type = 'Q'`, [securityId])).rows.map((r) => [r.end, r]));

  const write: Row[] = [];
  for (const row of incoming.values()) {
    const old = stored.get(row.end);
    if (!old) { write.push(row); counts.earningsInserted++; continue; }
    if (old.reported) { counts.earningsUnchanged++; continue; } // congelada al reportarse
    // mientras es futura, el último estado; un dato que llega vacío no borra el guardado
    const merged: Row = {
      end: row.end,
      report_date: row.report_date ?? old.report_date,
      report_time: row.report_time !== 'unknown' ? row.report_time : old.report_time,
      eps: row.eps ?? old.eps,
      currency: row.eps !== null ? row.currency : (old.currency ?? row.currency),
      reported: row.reported,
    };
    if (merged.report_date === old.report_date && merged.report_time === old.report_time && same(merged.eps, old.eps) && merged.currency === old.currency && merged.reported === old.reported) {
      counts.earningsUnchanged++;
      continue;
    }
    write.push(merged);
    counts.earningsUpdated++;
  }
  if (!write.length) return;
  await c.query(
    `INSERT INTO earnings (security_id, fiscal_period_end, period_type, report_date, report_time, eps_estimate, estimate_currency, is_reported)
     SELECT $1::bigint, i."end", 'Q', i.report_date, i.report_time, i.eps, i.currency, i.reported
     FROM jsonb_to_recordset($2::jsonb) AS i("end" date, report_date date, report_time text, eps numeric, currency text, reported boolean)
     ON CONFLICT (security_id, fiscal_period_end, period_type) DO UPDATE SET report_date = EXCLUDED.report_date, report_time = EXCLUDED.report_time,
       eps_estimate = EXCLUDED.eps_estimate, estimate_currency = EXCLUDED.estimate_currency, is_reported = EXCLUDED.is_reported
     WHERE earnings.is_reported = false`, [securityId, JSON.stringify(write)]);
}
