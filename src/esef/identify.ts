import type pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { decodeBody } from './codec.js';

// Candidatos LEI -> ISIN para los informes ESEF (P20). El XBRL no trae ISIN: se piden a GLEIF y solo se proponen los que aparecen en
// una lista de bolsa capturada (exchange-symbol-list), lo que descarta la deuda del emisor (hasta 1 813 ISIN por LEI). No escribe en
// COMPANY ni SECURITY: solo en esef_lei_isin (migración 019), que revisa una persona.
export const IDENTIFY_CONFIG = {
  gleifBase: 'https://api.gleif.org/api/v1',
  // PROVISIONAL: pausa mínima entre peticiones a GLEIF (cortesía; la documentación pública habla de ~60 por minuto).
  minIntervalMs: 1100,
  // PROVISIONAL: páginas de 200 ISIN por LEI; el spike vio LEI con más de 1 800 (Shell).
  pageSize: 200,
  maxPages: 20,
  // PROVISIONAL: aceptación automática solo si el ISIN es el único candidato, es de acción ordinaria y su prefijo es el país del informe.
  autoAcceptType: 'Common Stock',
  autoReviewer: 'auto',
} as const;

export interface ListedIsin { symbol: string; type: string | null; name: string | null }
export type ListIndex = Map<string, ListedIsin>;
export interface Candidate extends ListedIsin { lei: string; isin: string; status: 'proposed' | 'accepted' }
export interface IdentifyStats {
  leis: number; listIsins: number; withCandidate: number; accepted: number; proposed: number; noGleifIsin: number; truncated: number; failed: number;
}

// Pura: de los ISIN de GLEIF a candidatos. Una cotización por ISIN (la de menor símbolo, determinista).
export function proposeCandidates(lei: string, country: string | null, gleifIsins: string[], listed: ListIndex): Candidate[] {
  const found = [...new Set(gleifIsins)].filter((i) => listed.has(i)).sort();
  const autoOk = found.length === 1 && found[0]!.slice(0, 2) === country && listed.get(found[0]!)!.type === IDENTIFY_CONFIG.autoAcceptType;
  return found.map((isin) => ({ lei, isin, ...listed.get(isin)!, status: autoOk ? 'accepted' : 'proposed' }));
}

// ISIN de las listas de bolsa capturadas: la última captura correcta de cada código, sin EEUU (otro universo y sin interés para ESEF).
export async function loadListIndex(db: Pick<pg.Pool, 'query'> = pool): Promise<ListIndex> {
  const { rows } = await db.query<{ body: Buffer; body_format: string }>(
    `SELECT b.body, b.body_format
       FROM (SELECT DISTINCT ON (params->>'code') content_hash
               FROM raw_payload
              WHERE endpoint LIKE 'exchange-symbol-list%' AND http_status = 200 AND content_hash IS NOT NULL
                AND params->>'code' IS NOT NULL AND params->>'code' <> 'US' AND coalesce(params->>'delisted', '') = ''
              ORDER BY params->>'code', fetched_at DESC) r
       JOIN payload_blob b USING (content_hash)`,
  );
  const listed: ListIndex = new Map();
  for (const r of rows) {
    const list = JSON.parse(decodeBody(r.body, r.body_format).toString('utf8')) as { Code: string; Exchange: string; Type?: string; Name?: string; Isin?: string | null }[];
    for (const s of list) {
      if (!s.Isin) continue;
      const symbol = `${s.Code}.${s.Exchange}`;
      const prev = listed.get(s.Isin);
      if (!prev || symbol < prev.symbol) listed.set(s.Isin, { symbol, type: s.Type ?? null, name: s.Name ?? null });
    }
  }
  return listed;
}

type Fetch = typeof fetch;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ISIN de un LEI según GLEIF. null = GLEIF no conoce el LEI (400/404). Reintenta 429 y 5xx con espera creciente.
async function gleifIsins(lei: string, fetchFn: Fetch, pace: () => Promise<void>): Promise<{ isins: string[]; truncated: boolean } | null> {
  const isins: string[] = [];
  let page = 1;
  let last = 1;
  do {
    const url = `${IDENTIFY_CONFIG.gleifBase}/lei-records/${lei}/isins?page[size]=${IDENTIFY_CONFIG.pageSize}&page[number]=${page}`;
    let body: { data: { attributes: { isin: string } }[]; meta?: { pagination?: { lastPage?: number } } } | null = null;
    for (let attempt = 1; ; attempt++) {
      await pace();
      const res = await fetchFn(url, { headers: { accept: 'application/vnd.api+json', 'user-agent': config.secUserAgent } });
      if (res.status === 200) { body = await res.json() as typeof body; break; }
      if (res.status === 400 || res.status === 404) return null;
      if (attempt >= 3) throw new Error(`GLEIF ${res.status} para ${lei}`);
      await sleepMs(2000 * attempt);
    }
    for (const d of body!.data) isins.push(d.attributes.isin);
    last = body!.meta?.pagination?.lastPage ?? 1;
    page++;
  } while (page <= last && page <= IDENTIFY_CONFIG.maxPages);
  return { isins, truncated: last > IDENTIFY_CONFIG.maxPages };
}

// Guarda sin pisar la revisión de una persona: solo se reescribe una fila 'proposed' o aceptada por la regla automática.
export async function saveCandidates(db: Pick<pg.Pool, 'query'>, cands: Candidate[]): Promise<void> {
  for (const c of cands) {
    const auto = c.status === 'accepted';
    await db.query(
      `INSERT INTO esef_lei_isin (lei, isin, source, matched_symbol, matched_type, matched_name, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, 'gleif', $3, $4, $5, $6, $7, ${auto ? 'now()' : 'NULL'})
       ON CONFLICT (lei, isin) DO UPDATE SET source = EXCLUDED.source, matched_symbol = EXCLUDED.matched_symbol,
         matched_type = EXCLUDED.matched_type, matched_name = EXCLUDED.matched_name, status = EXCLUDED.status,
         reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at, generated_at = now()
       WHERE esef_lei_isin.status = 'proposed' OR esef_lei_isin.reviewed_by = '${IDENTIFY_CONFIG.autoReviewer}'`,
      [c.lei, c.isin, c.symbol, c.type, c.name, c.status, auto ? IDENTIFY_CONFIG.autoReviewer : null],
    );
  }
}

export interface IdentifyOptions { leis?: string[]; fetch?: Fetch; log?: (m: string) => void; sleep?: (ms: number) => Promise<void>; db?: Pick<pg.Pool, 'query'>; signal?: AbortSignal }

export async function identifyAll(opts: IdentifyOptions = {}): Promise<IdentifyStats> {
  const db = opts.db ?? pool;
  const fetchFn = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? sleepMs;
  const log = opts.log ?? (() => {});
  const listed = await loadListIndex(db);
  const where = opts.leis?.length ? 'WHERE lei = ANY($1)' : '';
  const { rows: leis } = await db.query<{ lei: string; country: string | null }>(
    `SELECT lei, min(country) AS country FROM esef_filing ${where} GROUP BY lei ORDER BY lei`, opts.leis?.length ? [opts.leis] : []);
  const stats: IdentifyStats = { leis: leis.length, listIsins: listed.size, withCandidate: 0, accepted: 0, proposed: 0, noGleifIsin: 0, truncated: 0, failed: 0 };
  let nextAt = 0;
  const pace = async () => { const wait = nextAt - Date.now(); if (wait > 0) await sleep(wait); nextAt = Date.now() + IDENTIFY_CONFIG.minIntervalMs; };
  for (const [i, l] of leis.entries()) {
    if (opts.signal?.aborted) break;
    try {
      const g = await gleifIsins(l.lei, fetchFn, pace);
      if (!g || g.isins.length === 0) { stats.noGleifIsin++; continue; }
      if (g.truncated) stats.truncated++;
      const cands = proposeCandidates(l.lei, l.country, g.isins, listed);
      if (cands.length) { stats.withCandidate++; await saveCandidates(db, cands); }
      for (const c of cands) stats[c.status === 'accepted' ? 'accepted' : 'proposed']++;
    } catch (e) {
      stats.failed++;
      log(`LEI ${l.lei}: ${(e as Error).message}`);
    }
    if ((i + 1) % 50 === 0) log(`  ${i + 1}/${leis.length} LEI`);
  }
  return stats;
}
