import { withActor } from '../db/withActor.js';
import { SUBUNITS } from '../fx/subunits.js';
import { emitFinding } from './findings.js';
import { RECENT_SESSIONS } from './revisions.js';

// Escritor de FX (eod/EURxxx.FOREX -> FX_RATES, decisiones-modelo.md §6 y §6.b). Base = EUR. Se guarda la cotización del proveedor
// TAL CUAL en units_per_base: unidades de xxx por 1 EUR (EURUSD.FOREX ~ 1,12 -> USD = 1,12); convertir a EUR = dividir. Sin
// filas EUR. Una subunidad (GBX, src/fx/subunits.ts) es una fila propia con la cotización de su unidad MULTIPLICADA por el factor
// (GBX = GBP x 100, peniques por 1 EUR): multiplicación exacta, sin redondeo.
// Revisiones del proveedor (D10 sustituida, como en precios): en las últimas RECENT_SESSIONS fechas guardadas de esa divisa se
// aceptan en silencio (el cierre del día en curso se mueve mientras cotiza); más atrás, UPDATE + PRICE_REVISED con objetivo
// {currency, date} y detail {old, new}. Idempotente.

export interface FxRecord { date?: string | null; close?: string | number | null }

export interface FxInput { rawPayloadId: string; runId: string; symbol: string; records: FxRecord[] }

export interface FxSummary {
  payloads: number;
  rows: number;
  inserted: number;
  revised: number; // revisión fuera de las últimas sesiones: UPDATE + PRICE_REVISED
  settled: number; // revisión dentro de las últimas sesiones: UPDATE en silencio
  unchanged: number;
  subunitRows: number; // filas de subunidad (GBX...) generadas, ya sean nuevas, revisadas o sin cambios
  skippedBadDate: number;
  skippedNoRate: number; // close ausente o no positivo
}

export const emptyFxSummary = (): FxSummary => ({ payloads: 0, rows: 0, inserted: 0, revised: 0, settled: 0, unchanged: 0, subunitRows: 0, skippedBadDate: 0, skippedNoRate: 0 });

const PAIR = /^EUR([A-Z]{3})\.FOREX$/;
export const isFxSymbol = (symbol: string | null): symbol is string => symbol !== null && symbol.endsWith('.FOREX');

export async function writeFx(input: FxInput): Promise<FxSummary> {
  const m = PAIR.exec(input.symbol);
  if (!m) throw new Error(`${input.symbol}: no es un cruce EURxxx.FOREX (la base es EUR)`);
  const currency = m[1]!;
  return withActor('normalizer', `fx desde raw_payload ${input.rawPayloadId}`, async (c) => {
    const s = emptyFxSummary();
    s.payloads = 1;
    const seen = new Set<string>();
    const dates: string[] = [], closes: string[] = [];
    for (const r of input.records) {
      s.rows++;
      if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) { s.skippedBadDate++; continue; }
      const close = r.close === null || r.close === undefined || r.close === '' ? null : String(r.close);
      if (close === null || !(Number(close) > 0)) { s.skippedNoRate++; continue; }
      if (seen.has(r.date)) continue; // gana la primera
      seen.add(r.date);
      dates.push(r.date); closes.push(close);
    }
    if (!dates.length) return s;

    const upsert = async (cur: string, factor: number) => {
      const incoming = `unnest($2::date[], $3::numeric[]) AS i(date, close)`;
      const args = [cur, dates, closes, factor];
      const ins = await c.query(
        `INSERT INTO fx_rates (currency, date, units_per_base) SELECT $1::text, i.date, i.close * $4::numeric FROM ${incoming} ON CONFLICT (currency, date) DO NOTHING`, args);
      const rev = await c.query<{ date: string; old: string; new: string; recent: boolean }>(
        `SELECT i.date::text AS date, f.units_per_base::text AS old, (i.close * $4::numeric)::text AS new,
                f.date IN (SELECT date FROM fx_rates WHERE currency = $1::text ORDER BY date DESC LIMIT ${RECENT_SESSIONS}) AS recent
         FROM ${incoming} JOIN fx_rates f ON f.currency = $1::text AND f.date = i.date
         WHERE f.units_per_base IS DISTINCT FROM i.close * $4::numeric ORDER BY i.date`, args);
      if (rev.rowCount) {
        await c.query(
          `UPDATE fx_rates f SET units_per_base = i.close * $4::numeric FROM ${incoming}
           WHERE f.currency = $1::text AND f.date = i.date AND f.units_per_base IS DISTINCT FROM i.close * $4::numeric`, args);
      }
      let revised = 0, settled = 0;
      for (const r of rev.rows) {
        if (r.recent) { settled++; continue; }
        revised++;
        await emitFinding(c, {
          ruleCode: 'PRICE_REVISED', targetTable: 'fx_rates', targetKey: { currency: cur, date: r.date },
          detail: { old: { units_per_base: r.old }, new: { units_per_base: r.new } }, detectedByRun: input.runId, keepFirstOld: true,
        });
      }
      const inserted = ins.rowCount ?? 0;
      return { inserted, revised, settled, total: dates.length };
    };

    const main = await upsert(currency, 1);
    s.inserted = main.inserted; s.revised = main.revised; s.settled = main.settled; s.unchanged = main.total - main.inserted - main.revised - main.settled;
    for (const [sub, { unit, factor }] of Object.entries(SUBUNITS)) {
      if (unit !== currency) continue;
      const x = await upsert(sub, factor);
      s.subunitRows += x.total; s.inserted += x.inserted; s.revised += x.revised; s.settled += x.settled;
    }
    return s;
  });
}
