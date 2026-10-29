import { createHash } from 'node:crypto';
import { decodeBody } from '../esef/codec.js';
import type { Queryable } from './review.js';

// PROVISIONAL: único sitio con el tope del cuerpo descomprimido que el visor acepta abrir.
export const VIEWER_MAX_BYTES = 20 * 1024 * 1024;

export interface BlobResumen {
  contentHash: string;
  bodyFormat: string;
  sizeBytes: number;
  source: string | null;
  endpoint: string | null;
  fetchedAt: string | null;
}

export class VisorError extends Error {
  constructor(public status: 400 | 404 | 413 | 422, msg: string) { super(msg); }
}

interface FilaBlob {
  content_hash: string; body_format: string; size_bytes: string; provider: string | null; endpoint: string | null; fetched_at: Date | null;
}
const aResumen = (r: FilaBlob): BlobResumen => ({
  contentHash: r.content_hash, bodyFormat: r.body_format, sizeBytes: Number(r.size_bytes),
  source: r.provider, endpoint: r.endpoint, fetchedAt: r.fetched_at ? r.fetched_at.toISOString() : null,
});

// Una fila por blob, con los datos de su llamada más reciente (si la hay).
const SELECT_BLOB = `
  SELECT b.content_hash, b.body_format, b.size_bytes, r.provider, r.endpoint, r.fetched_at
  FROM payload_blob b
  LEFT JOIN LATERAL (
    SELECT i.provider, p.endpoint, p.fetched_at FROM raw_payload p JOIN ingestion_run i USING (ingestion_run_id)
     WHERE p.content_hash = b.content_hash ORDER BY p.fetched_at DESC LIMIT 1) r ON true`;

const escaparLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

export async function buscar(c: Queryable, q: string, limit = 50): Promise<BlobResumen[]> {
  const texto = q.trim();
  if (!texto) throw new VisorError(400, 'falta el texto a buscar');
  const like = escaparLike(texto);
  const rows = (await c.query<FilaBlob>(
    `${SELECT_BLOB}
     WHERE b.content_hash LIKE lower($1) || '%' ESCAPE '\\' OR r.endpoint ILIKE '%' || $1 || '%' ESCAPE '\\' OR r.provider ILIKE $1 || '%' ESCAPE '\\'
     ORDER BY r.fetched_at DESC NULLS LAST, b.first_seen_at DESC LIMIT $2`, [like, limit])).rows;
  return rows.map(aResumen);
}

export async function abrir(c: Queryable, contentHash: string): Promise<{ resumen: BlobResumen; hashOk: boolean; json: unknown }> {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new VisorError(400, 'hash no válido');
  const rows = (await c.query<FilaBlob & { body: Buffer | null }>(`${SELECT_BLOB.replace('SELECT b.content_hash,', 'SELECT b.body, b.content_hash,')} WHERE b.content_hash = $1`, [contentHash])).rows;
  const r = rows[0];
  if (!r || r.body === null) throw new VisorError(404, r ? 'el cuerpo está purgado' : 'no existe ese hash');
  if (Number(r.size_bytes) > VIEWER_MAX_BYTES) throw new VisorError(413, `el cuerpo supera el tope de ${VIEWER_MAX_BYTES} bytes`);
  let bytes: Buffer;
  try { bytes = decodeBody(r.body, r.body_format); } catch (e) { throw new VisorError(422, (e as Error).message); }
  if (bytes.length > VIEWER_MAX_BYTES) throw new VisorError(413, `el cuerpo supera el tope de ${VIEWER_MAX_BYTES} bytes`);
  let json: unknown;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { throw new VisorError(422, 'el cuerpo no es JSON'); }
  return { resumen: aResumen(r), hashOk: createHash('sha256').update(bytes).digest('hex') === contentHash, json };
}
