import { pool } from '../db/pool.js';
import type { Job } from './jobs.js';

// div/ y splits/ solo se piden del listing PRIMARIO de cada security (decisiones-modelo.md §5.5, D11 sustituida): dos listings de
// la misma security que discrepen harían oscilar el evento. Un símbolo sin listing (aún no hay lista de símbolos que lo cree) no
// se puede situar y tampoco se pide. El resto de endpoints pasan sin filtrar.
const PRIMARY_ONLY = new Set(['div/{symbol}', 'splits/{symbol}']);

export interface SkippedJob { symbol: string; endpoint: string; reason: 'no es el listing primario' | 'sin listing' }

export async function keepPrimaryListings(jobs: Job[]): Promise<{ jobs: Job[]; skipped: SkippedJob[] }> {
  const symbols = [...new Set(jobs.filter((j) => PRIMARY_ONLY.has(j.endpoint) && j.symbol).map((j) => j.symbol!))];
  const primary = new Map<string, boolean>();
  if (symbols.length) {
    const r = await pool.query<{ provider_symbol: string; is_primary_listing: boolean }>('SELECT provider_symbol, is_primary_listing FROM listing WHERE provider_symbol = ANY($1)', [symbols]);
    for (const row of r.rows) primary.set(row.provider_symbol, row.is_primary_listing);
  }
  const kept: Job[] = [], skipped: SkippedJob[] = [];
  for (const j of jobs) {
    if (!PRIMARY_ONLY.has(j.endpoint) || !j.symbol) { kept.push(j); continue; }
    const p = primary.get(j.symbol);
    if (p) kept.push(j);
    else skipped.push({ symbol: j.symbol, endpoint: j.endpoint, reason: p === undefined ? 'sin listing' : 'no es el listing primario' });
  }
  return { jobs: kept, skipped };
}
