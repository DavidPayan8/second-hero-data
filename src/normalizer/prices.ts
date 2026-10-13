import { withActor } from '../db/withActor.js';
import { emitFinding } from './findings.js';

// ------------------------------------------------------------------------------------------------------------------
// JSON con los números como TEXTO EXACTO. JSON.parse convertiría 214.2300 en 214.23 y un entero grande en un double; el
// reviver con `context.source` (Node >= 21) devuelve el texto tal cual venía en el cuerpo, y Postgres lo guarda como numeric.
// ------------------------------------------------------------------------------------------------------------------
export function parseJsonExact(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && context?.source !== undefined ? context.source : value;
  return (JSON.parse as unknown as (t: string, r: typeof reviver) => unknown)(text, reviver);
}

export interface EodRecord {
  date?: string | null;
  open?: string | number | null;
  high?: string | number | null;
  low?: string | number | null;
  close?: string | number | null;
  adjusted_close?: string | number | null; // NO se guarda: el ajustado se recalcula con cada split nuevo y se deriva en VISTAS
  volume?: string | number | null;
}

export interface PricesInput {
  rawPayloadId: string;
  runId: string;
  symbol: string; // provider_symbol, p. ej. AAPL.US
  records: EodRecord[];
}

export interface PricesSummary {
  payloads: number;
  rows: number;
  inserted: number;
  unchanged: number;
  revised: number; // ya había un precio distinto: se actualiza y se emite PRICE_REVISED
  settled: number; // solo cambió el volumen de una de las últimas sesiones: se actualiza en silencio
  skippedNoClose: number;
  skippedBadDate: number;
  skippedDuplicate: number;
  noListing: number; // listing aún inexistente: el payload queda pendiente y se reintenta
}

export const emptyPricesSummary = (): PricesSummary => ({ payloads: 0, rows: 0, inserted: 0, unchanged: 0, revised: 0, settled: 0, skippedNoClose: 0, skippedBadDate: 0, skippedDuplicate: 0, noListing: 0 });

// P13 (decisiones-modelo.md §5): un cambio SOLO de volume en las últimas N sesiones del listing es el asentamiento normal del
// volumen consolidado y se acepta en silencio. N = 5 es provisional y vive solo aquí.
export const VOLUME_SETTLE_SESSIONS = 5;

const num = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

// Escritor de precios brutos (eod/{symbol} -> PRICES_DAILY). Solo open, high, low, close y volume en la unidad del proveedor, sin
// tocar (la divisa es LISTING.quote_currency; GBX se queda en GBX). "Inmutable" significa que nosotros no reescribimos el bruto;
// el proveedor sí puede corregirlo (P13, D9 sustituida): una revisión se ACEPTA (UPDATE de la fila).
//  - Cambia solo volume y la fecha está entre las VOLUME_SETTLE_SESSIONS últimas sesiones del listing: en silencio.
//  - Cambia open/high/low/close, o volume fuera de esa ventana: UPDATE + PRICE_REVISED {old, new}; si ya hay uno abierto se
//    conserva el `old` del primero.
// Idempotente: repetirlo no cambia nada. Devuelve null si el listing todavía no existe: el payload se queda pendiente.
export async function writePrices(input: PricesInput): Promise<PricesSummary | null> {
  return withActor('normalizer', `precios desde raw_payload ${input.rawPayloadId}`, async (c) => {
    const listing = (await c.query<{ id: string }>('SELECT listing_id AS id FROM listing WHERE provider_symbol = $1', [input.symbol])).rows[0];
    if (!listing) return null;

    const s = emptyPricesSummary();
    s.payloads = 1;
    const seen = new Set<string>();
    const dates: string[] = [], opens: (string | null)[] = [], highs: (string | null)[] = [], lows: (string | null)[] = [], closes: (string | null)[] = [], volumes: (string | null)[] = [];
    for (const r of input.records) {
      s.rows++;
      const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
      if (!date) { s.skippedBadDate++; continue; }
      const close = num(r.close);
      if (close === null) { s.skippedNoClose++; continue; }
      if (seen.has(date)) { s.skippedDuplicate++; continue; }
      seen.add(date);
      dates.push(date); opens.push(num(r.open)); highs.push(num(r.high)); lows.push(num(r.low)); closes.push(close); volumes.push(num(r.volume));
    }
    if (!dates.length) return s;

    const incoming = `unnest($2::date[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[]) AS i(date, open, high, low, close, volume)`;
    const args = [listing.id, dates, opens, highs, lows, closes, volumes];
    const ins = await c.query(
      `INSERT INTO prices_daily (listing_id, date, open, high, low, close, volume)
       SELECT $1::bigint, i.date, i.open, i.high, i.low, i.close, i.volume FROM ${incoming} ON CONFLICT (listing_id, date) DO NOTHING`, args);
    s.inserted = ins.rowCount ?? 0;

    // Fechas que ya existían con otros valores (la comparación es numérica: 214.2300 y 214.23 son lo mismo). La ventana de
    // "últimas sesiones" se mide sobre las fechas guardadas del listing, ya con lo recién insertado.
    const rev = await c.query<{ date: string; old: Record<string, string | null>; new: Record<string, string | null>; only_volume: boolean; recent: boolean }>(
      `SELECT i.date::text AS date,
              jsonb_build_object('open', p.open, 'high', p.high, 'low', p.low, 'close', p.close, 'volume', p.volume) AS old,
              jsonb_build_object('open', i.open, 'high', i.high, 'low', i.low, 'close', i.close, 'volume', i.volume) AS new,
              (p.open, p.high, p.low, p.close) IS NOT DISTINCT FROM (i.open, i.high, i.low, i.close) AS only_volume,
              p.date IN (SELECT date FROM prices_daily WHERE listing_id = $1::bigint ORDER BY date DESC LIMIT ${VOLUME_SETTLE_SESSIONS}) AS recent
       FROM ${incoming} JOIN prices_daily p ON p.listing_id = $1::bigint AND p.date = i.date
       WHERE (p.open, p.high, p.low, p.close, p.volume) IS DISTINCT FROM (i.open, i.high, i.low, i.close, i.volume)
       ORDER BY i.date`, args);
    s.unchanged = dates.length - s.inserted - (rev.rowCount ?? 0);
    if (rev.rowCount) {
      await c.query(
        `UPDATE prices_daily p SET open = i.open, high = i.high, low = i.low, close = i.close, volume = i.volume
         FROM ${incoming} WHERE p.listing_id = $1::bigint AND p.date = i.date
           AND (p.open, p.high, p.low, p.close, p.volume) IS DISTINCT FROM (i.open, i.high, i.low, i.close, i.volume)`, args);
    }
    for (const r of rev.rows) {
      if (r.only_volume && r.recent) { s.settled++; continue; }
      s.revised++;
      await emitFinding(c, {
        ruleCode: 'PRICE_REVISED', targetTable: 'prices_daily', targetKey: { listing_id: Number(listing.id), date: r.date },
        detail: { old: r.old, new: r.new }, detectedByRun: input.runId, keepFirstOld: true,
      });
    }
    return s;
  });
}

