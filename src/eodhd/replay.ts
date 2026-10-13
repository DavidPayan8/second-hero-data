import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { writeListings, type ListingsInput, type ListingsSummary, type SymbolRecord } from '../normalizer/listings.js';
import { emptyPricesSummary, parseJsonExact, writePrices, type EodRecord, type PricesSummary } from '../normalizer/prices.js';

export interface ReplaySummary {
  checked: number;
  ok: number;
  error: number;
  deferred: number; // payloads que dependen de algo que aún no existe (p. ej. precios de un símbolo sin listing): siguen pendientes
  listings?: ListingsSummary;
  listingsSweeps?: number; // pasadas del escritor de listings hasta que dejó de cambiar nada
  prices?: PricesSummary;
}

// Contadores de EVENTOS (lo que una pasada cambia) frente a contadores de ESTADO (lo que una pasada ve).
// (reappeared, los conflictos y los hallazgos son estado: emitir de nuevo el mismo finding no cambia nada.)
const EVENT_KEYS: (keyof ListingsSummary)[] = ['created', 'updated', 'securitiesCreated', 'companiesCreated', 'primaryChanges'];
const changed = (x: ListingsSummary) => EVENT_KEYS.some((k) => x[k] > 0);
const MAX_SWEEPS = 5;

interface Row { id: string; run_id: string; endpoint: string; provider_symbol: string | null; params: Record<string, string>; http_status: number; content_hash: string }

// Replay = volver a pasar desde raw_payload + payload_blob, SIN red (este módulo no importa el cliente HTTP) y sin
// cargar ficheros. Primero comprueba cada payload y marca parse_status; los escritores de la fuente de verdad se enganchan
// por endpoint, en este orden (cada uno depende del anterior):
//   1. exchange-symbol-list/{code} -> listings (src/normalizer/listings.ts), repetido hasta que una pasada no cambie nada.
//   2. eod/{symbol}               -> precios brutos (src/normalizer/prices.ts), cuando el listing ya existe.
// Los demás endpoints (div, splits, fundamentals...) solo se comprueban hasta que tengan escritor.
//   ok       : respuesta 2xx, hash que coincide, JSON válido (un BOM inicial se tolera al decodificar) y escritor sin error.
//   error    : cuerpo purgado, hash que no coincide, HTTP no 2xx, JSON inválido o fallo del escritor (se revierte su transacción).
//   pendiente: el escritor no puede trabajar todavía (precios de un símbolo sin listing): no se marca y se reintenta en el siguiente replay.
// Por defecto solo recorre las filas en 'pending'. Con `all` vuelve a pasar el ÚLTIMO payload de cada (endpoint, params,
// símbolo), también si ya estaba marcado: los escritores son idempotentes, así que repetirlo no cambia recuentos ni deja
// filas nuevas en dimension_audit.
// Las filas sin respuesta (transport_error) tienen parse_status NULL y no hay nada que releer.
export async function replay(options: { runId?: string; all?: boolean } = {}): Promise<ReplaySummary> {
  const rows = await pool.query<Row>(
    `SELECT raw_payload_id AS id, ingestion_run_id AS run_id, endpoint, provider_symbol, params, http_status, content_hash FROM raw_payload
     WHERE ${options.all
       // `all`: solo el último payload de cada (endpoint, params, símbolo). Repasar el historial entero reaplicaría capturas
       // viejas por encima de las nuevas; lo anterior ya quedó reflejado cuando llegó.
       ? `parse_status IS NOT NULL AND raw_payload_id = (SELECT max(r2.raw_payload_id) FROM raw_payload r2
            WHERE r2.endpoint = raw_payload.endpoint AND r2.params = raw_payload.params AND r2.provider_symbol IS NOT DISTINCT FROM raw_payload.provider_symbol AND r2.parse_status IS NOT NULL)`
       : "parse_status = 'pending'"} AND ($1::bigint IS NULL OR ingestion_run_id = $1::bigint)
     ORDER BY raw_payload_id`,
    [options.runId ?? null],
  );
  const summary: ReplaySummary = { checked: 0, ok: 0, error: 0, deferred: 0 };
  const listingInputs: ListingsInput[] = [];
  const priceItems: { row: Row; records: EodRecord[] }[] = [];

  const mark = async (row: Row, problem: string | null) => {
    await pool.query('UPDATE raw_payload SET parse_status = $2, parse_error = $3 WHERE raw_payload_id = $1', [row.id, problem ? 'error' : 'ok', problem]);
    summary.checked++;
    if (problem) summary.error++; else summary.ok++;
  };

  for (const row of rows.rows) {
    const blob = (await pool.query<{ body: Buffer | null }>('SELECT body FROM payload_blob WHERE content_hash = $1', [row.content_hash])).rows[0];
    let problem: string | null = null;
    let parsed: unknown;
    if (!blob || blob.body === null) problem = 'cuerpo purgado: no se puede releer';
    else if (createHash('sha256').update(blob.body).digest('hex') !== row.content_hash) problem = 'el hash del cuerpo guardado no coincide con content_hash';
    else if (row.http_status < 200 || row.http_status >= 300) problem = `HTTP ${row.http_status}: ${blob.body.toString('utf8', 0, 200)}`;
    else {
      // TextDecoder descarta un BOM inicial al decodificar; los bytes guardados no se tocan. Los números se leen como texto
      // exacto para que Postgres los guarde como numeric sin pasar por un double.
      try { parsed = parseJsonExact(new TextDecoder('utf-8').decode(blob.body)); } catch (e) { problem = `JSON inválido: ${(e as Error).message}`; }
    }

    if (!problem && row.endpoint === 'exchange-symbol-list/{code}') {
      try {
        if (!Array.isArray(parsed)) throw new Error('se esperaba una lista de símbolos');
        const input = { rawPayloadId: row.id, runId: row.run_id, code: row.params.code ?? '', delisted: row.params.delisted === '1', records: parsed as SymbolRecord[] };
        const s = await writeListings(input);
        listingInputs.push(input);
        summary.listings = addCounts(summary.listings, s);
      } catch (e) {
        problem = `escritor de listings: ${(e as Error).message}`;
      }
    }

    if (!problem && row.endpoint === 'eod/{symbol}') {
      if (!Array.isArray(parsed)) problem = 'escritor de precios: se esperaba una lista de precios';
      else if (!row.provider_symbol) problem = 'escritor de precios: la fila no tiene provider_symbol';
      else { priceItems.push({ row, records: parsed as EodRecord[] }); continue; } // se marca después, con el listing ya estable
    }

    await mark(row, problem);
  }

  // Las listas de símbolos se enlazan entre sí por ISIN (una acción cotizada en Londres reutiliza la security creada desde la
  // lista de EEUU): el resultado de una pasada puede depender del orden en que se procesaron las listas. Se repite el escritor
  // sobre las mismas listas hasta que una pasada no cambie nada, de modo que un replay deja un estado estable y repetirlo no
  // produce filas nuevas. Los contadores de eventos se suman; los de estado son los de la última pasada.
  if (summary.listings && listingInputs.length > 1) {
    let sweeps = 1;
    let events = changed(summary.listings);
    while (events && sweeps < MAX_SWEEPS) {
      let last: ListingsSummary | undefined;
      for (const input of listingInputs) last = addCounts(last, await writeListings(input));
      sweeps++;
      summary.listings = { ...last!, ...Object.fromEntries(EVENT_KEYS.map((k) => [k, summary.listings![k] + last![k]])) } as ListingsSummary;
      events = changed(last!);
    }
    summary.listingsSweeps = sweeps;
  } else if (summary.listings) summary.listingsSweeps = 1;

  // Precios: después de las listas, cuando los listings ya existen.
  for (const { row, records } of priceItems) {
    let problem: string | null = null;
    try {
      const s = await writePrices({ rawPayloadId: row.id, runId: row.run_id, symbol: row.provider_symbol!, records });
      if (s === null) {
        summary.deferred++;
        summary.prices = addPrices(summary.prices, { ...emptyPricesSummary(), noListing: 1 });
        continue; // sin listing todavía: sigue pendiente
      }
      summary.prices = addPrices(summary.prices, s);
    } catch (e) {
      problem = `escritor de precios: ${(e as Error).message}`;
    }
    await mark(row, problem);
  }
  return summary;
}

function addCounts(a: ListingsSummary | undefined, b: ListingsSummary): ListingsSummary {
  const out = { ...b };
  if (a) for (const k of Object.keys(b) as (keyof ListingsSummary)[]) out[k] = a[k] + b[k];
  return out;
}

function addPrices(a: PricesSummary | undefined, b: PricesSummary): PricesSummary {
  const out = { ...b };
  if (a) for (const k of Object.keys(b) as (keyof PricesSummary)[]) out[k] = a[k] + b[k];
  return out;
}
