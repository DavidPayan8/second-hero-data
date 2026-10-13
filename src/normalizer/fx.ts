import { withActor } from '../db/withActor.js';
import { SUBUNITS } from '../fx/subunits.js';

// Escritor de FX (eod/EURxxx.FOREX -> FX_RATES, decisiones-modelo.md §6 y §6.a). Base = EUR. EODHD da el cruce como unidades de
// xxx por 1 EUR (EURUSD.FOREX ~ 1,12), y rate_to_base es el valor de 1 unidad de xxx en EUR: rate_to_base = 1 / close
// (la división la hace Postgres en numeric, sin pasar por un double). Una subunidad (GBX, src/fx/subunits.ts) es una fila propia
// con el tipo de su unidad dividido por el factor (GBX = GBP / 100), generada a partir de la fila de la unidad del mismo día.
// No se escribe fila EUR: la base no tiene tipo.
// Revisión del proveedor (D10, provisional): el último cierre diario de un cruce se mueve durante el día, así que un valor distinto
// para una fecha ya guardada se ACEPTA (UPDATE) en silencio y se cuenta en `revised`. Idempotente.

export interface FxRecord { date?: string | null; close?: string | number | null }

export interface FxInput { rawPayloadId: string; runId: string; symbol: string; records: FxRecord[] }

export interface FxSummary {
  payloads: number;
  rows: number;
  inserted: number;
  revised: number;
  unchanged: number;
  subunitRows: number; // filas de subunidad (GBX...) generadas, ya sean nuevas, revisadas o sin cambios
  skippedBadDate: number;
  skippedNoRate: number; // close ausente o no positivo
}

export const emptyFxSummary = (): FxSummary => ({ payloads: 0, rows: 0, inserted: 0, revised: 0, unchanged: 0, subunitRows: 0, skippedBadDate: 0, skippedNoRate: 0 });

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

    const upsert = async (cur: string, divisor: number) => {
      const r = await c.query<{ inserted: boolean }>(
        `INSERT INTO fx_rates (currency, date, rate_to_base)
         SELECT $1::text, d, 1 / c / $4::numeric FROM unnest($2::date[], $3::numeric[]) AS i(d, c)
         ON CONFLICT (currency, date) DO UPDATE SET rate_to_base = EXCLUDED.rate_to_base
           WHERE fx_rates.rate_to_base IS DISTINCT FROM EXCLUDED.rate_to_base
         RETURNING (xmax = 0) AS inserted`, [cur, dates, closes, divisor]);
      const inserted = r.rows.filter((x) => x.inserted).length;
      return { inserted, revised: r.rows.length - inserted, total: dates.length };
    };

    const main = await upsert(currency, 1);
    s.inserted = main.inserted; s.revised = main.revised; s.unchanged = main.total - main.inserted - main.revised;
    for (const [sub, { unit, factor }] of Object.entries(SUBUNITS)) {
      if (unit !== currency) continue;
      const x = await upsert(sub, factor);
      s.subunitRows += x.total; s.inserted += x.inserted; s.revised += x.revised;
    }
    return s;
  });
}
