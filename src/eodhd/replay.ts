import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';

export interface ReplaySummary {
  checked: number;
  ok: number;
  error: number;
}

// Replay: relee de raw_payload + payload_blob SIN red (este módulo no importa el cliente HTTP). De momento solo recorre
// y marca parse_status, porque aún no hay escritores de la fuente de verdad. Cuando existan, cada escritor se engancha
// aquí y todo lo posterior sale únicamente de raw_payload, venga de la API o de fichero.
//   ok     : respuesta 2xx, cuerpo presente con el hash esperado y JSON válido.
//   error  : cuerpo purgado, hash que no coincide, estado HTTP que no es 2xx o JSON inválido (parse_error lo explica).
// Solo recorre las filas en 'pending' (las filas sin respuesta, con parse_status NULL, no tienen nada que releer).
export async function replay(options: { runId?: string } = {}): Promise<ReplaySummary> {
  const pending = await pool.query<{ id: string; http_status: number; content_hash: string }>(
    `SELECT raw_payload_id AS id, http_status, content_hash FROM raw_payload
     WHERE parse_status = 'pending' AND ($1::bigint IS NULL OR ingestion_run_id = $1::bigint) ORDER BY raw_payload_id`,
    [options.runId ?? null],
  );
  const summary: ReplaySummary = { checked: 0, ok: 0, error: 0 };
  for (const row of pending.rows) {
    const blob = (await pool.query<{ body: Buffer | null }>('SELECT body FROM payload_blob WHERE content_hash = $1', [row.content_hash])).rows[0];
    let problem: string | null = null;
    if (!blob || blob.body === null) problem = 'cuerpo purgado: no se puede releer';
    else if (createHash('sha256').update(blob.body).digest('hex') !== row.content_hash) problem = 'el hash del cuerpo guardado no coincide con content_hash';
    else if (row.http_status < 200 || row.http_status >= 300) problem = `HTTP ${row.http_status}: ${blob.body.toString('utf8', 0, 200)}`;
    else {
      // TextDecoder descarta un BOM inicial al decodificar; los bytes guardados no se tocan.
      try { JSON.parse(new TextDecoder('utf-8').decode(blob.body)); } catch (e) { problem = `JSON inválido: ${(e as Error).message}`; }
    }
    await pool.query('UPDATE raw_payload SET parse_status = $2, parse_error = $3 WHERE raw_payload_id = $1', [row.id, problem ? 'error' : 'ok', problem]);
    summary.checked++;
    if (problem) summary.error++; else summary.ok++;
  }
  return summary;
}
