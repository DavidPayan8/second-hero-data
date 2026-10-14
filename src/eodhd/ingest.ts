import { createHash } from 'node:crypto';
import type pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { clientOptions, fetchRaw, type ClientOptions, type FetchResult } from './client.js';
import { resolvePath, type Job } from './jobs.js';
import { PROVIDER } from './provider.js';

export { PROVIDER };

export interface CaptureOptions extends Partial<ClientOptions> {
  budget?: number; // tope de coste por corrida (llamadas de cuota); se para ANTES de superarlo
  maxAttempts?: number; // intentos por trabajo; cada intento es una fila nueva en raw_payload
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number; // reloj en ms (por defecto Date.now); se inyecta junto con sleep para no depender del tiempo real en los tests
  log?: (message: string) => void;
  // Otro proveedor con el mismo mecanismo de captura (p. ej. la SEC para la 2ª fuente): su nombre en ingestion_run.provider, la
  // función que hace la llamada de un trabajo (por defecto, EODHD con su token) y la pausa mínima entre llamadas (límite de peticiones).
  provider?: string;
  fetcher?: (job: Job) => Promise<FetchResult>;
  minIntervalMs?: number;
}

export interface CaptureSummary {
  runId: string;
  scope: string;
  status: 'ok' | 'partial' | 'failed';
  attempts: number;
  ok: number;
  errors: number;
  spent: number;
  budget: number;
  jobsDone: number;
  jobsSkipped: number;
  closedStale: number;
  stoppedBy?: 'budget' | 'rate_limit';
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isOk = (r: FetchResult) => r.kind === 'response' && r.status >= 200 && r.status < 300;

// Escribe un intento: blob (dedup por hash), fila de raw_payload y contadores de la corrida, todo en una transacción
// para que una corrida que muera deje contadores coherentes con sus filas.
async function recordAttempt(runId: string, job: Job, result: FetchResult): Promise<void> {
  if ('api_token' in job.params) throw new Error('api_token no puede ir en params');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (result.kind === 'response') {
      // El hash es el de los bytes exactos recibidos y el cuerpo se guarda tal cual, sin re-serializar ni transformar.
      const hash = sha256(result.body);
      await client.query(
        'INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, $2, $3) ON CONFLICT (content_hash) DO NOTHING',
        [hash, result.body, result.body.length],
      );
      await client.query(
        `INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash, fetched_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [runId, job.endpoint, job.symbol ?? null, JSON.stringify(job.params), result.status, hash, result.fetchedAt],
      );
    } else {
      await client.query(
        `INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash, fetched_at, parse_status, transport_error)
         VALUES ($1, $2, $3, $4::jsonb, NULL, NULL, $5, NULL, $6)`,
        [runId, job.endpoint, job.symbol ?? null, JSON.stringify(job.params), result.fetchedAt, result.error],
      );
    }
    await client.query(
      'UPDATE ingestion_run SET req_count = req_count + 1, ok_count = ok_count + $2, error_count = error_count + $3 WHERE ingestion_run_id = $1',
      [runId, isOk(result) ? 1 : 0, isOk(result) ? 0 : 1],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Captura un scope: una ingestion_run por scope y una raw_payload por intento (los reintentos son filas nuevas).
//  - 4xx y 5xx son respuesta (con cuerpo en payload_blob); timeout, corte o cuerpo truncado son transport_error.
//  - 5xx y fallos de transporte se reintentan hasta maxAttempts. 429 (límite de peticiones) y 402 (cuota agotada) paran
//    la corrida: seguir solo gastaría cuota. Los demás 4xx no se reintentan.
//  - Antes de cada intento se comprueba el presupuesto de la corrida: no se hace una llamada que lo supere.
//  - Al arrancar se cierran como 'failed' las corridas del mismo scope que se quedaron en 'running' (el proceso murió).
//    Un lock de sesión por scope evita cerrar una corrida que sigue viva en otro proceso.
export async function capture(scope: string, jobs: Job[], options: CaptureOptions = {}): Promise<CaptureSummary> {
  const opts = clientOptions(options);
  const budget = options.budget ?? config.runBudget;
  const maxAttempts = options.maxAttempts ?? config.maxAttempts;
  const retryDelayMs = options.retryDelayMs ?? config.retryDelayMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  const provider = options.provider ?? PROVIDER;
  const fetcher = options.fetcher ?? ((job: Job) => { const { path, query } = resolvePath(job); return fetchRaw(path, query, opts); });
  const minIntervalMs = options.minIntervalMs ?? 0;
  let lastCallAt = 0;

  const lockClient: pg.PoolClient = await pool.connect();
  let runId: string | undefined;
  let finished = false;
  try {
    const lock = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [`ingest:${provider}:${scope}`]);
    if (!lock.rows[0]!.ok) throw new Error(`Ya hay una corrida en marcha para el scope ${scope}`);

    const stale = await pool.query(
      "UPDATE ingestion_run SET status = 'failed', finished_at = now() WHERE provider = $1 AND scope = $2 AND status = 'running'",
      [provider, scope],
    );
    const closedStale = stale.rowCount ?? 0;
    if (closedStale) log(`Cerradas como failed ${closedStale} corridas colgadas del scope ${scope}`);

    runId = (await pool.query<{ id: string }>('INSERT INTO ingestion_run (provider, scope) VALUES ($1, $2) RETURNING ingestion_run_id AS id', [provider, scope])).rows[0]!.id;

    let spent = 0;
    let attempts = 0;
    let ok = 0;
    let errors = 0;
    let jobsDone = 0;
    let stoppedBy: CaptureSummary['stoppedBy'];

    jobLoop: for (const job of jobs) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (spent + job.cost > budget) { stoppedBy = 'budget'; break jobLoop; }
        if (minIntervalMs > 0) { const wait = lastCallAt + minIntervalMs - now(); if (wait > 0) await sleep(wait); }
        lastCallAt = now();
        const result = await fetcher(job);
        spent += job.cost;
        attempts++;
        await recordAttempt(runId, job, result);
        if (isOk(result)) { ok++; jobsDone++; break; }
        errors++;
        const status = result.kind === 'response' ? result.status : undefined;
        log(`${job.endpoint} ${job.symbol ?? ''} (intento ${attempt}/${maxAttempts}): ${result.kind === 'response' ? `HTTP ${result.status}` : result.error}`.replace(/\s+/g, ' '));
        if (status === 429 || status === 402) { stoppedBy = 'rate_limit'; break jobLoop; }
        const retryable = status === undefined || status >= 500;
        if (!retryable) { jobsDone++; break; } // 4xx: respuesta definitiva
        if (attempt === maxAttempts) { jobsDone++; break; }
        await sleep(retryDelayMs);
      }
    }

    const jobsSkipped = jobs.length - jobsDone;
    // Cerrada sin errores y completa = ok; con algo ok pero incompleta o con errores = partial; sin nada ok = failed.
    const status: CaptureSummary['status'] = ok === 0 && (errors > 0 || jobsSkipped > 0) ? 'failed' : errors > 0 || jobsSkipped > 0 ? 'partial' : 'ok';
    await pool.query('UPDATE ingestion_run SET status = $2, finished_at = now() WHERE ingestion_run_id = $1', [runId, status]);
    finished = true;
    return { runId, scope, status, attempts, ok, errors, spent, budget, jobsDone, jobsSkipped, closedStale, stoppedBy };
  } finally {
    // Si algo inesperado rompió la corrida (p. ej. la base de datos), no se deja en 'running'.
    if (runId && !finished) {
      await pool.query("UPDATE ingestion_run SET status = 'failed', finished_at = now() WHERE ingestion_run_id = $1 AND status = 'running'", [runId]).catch(() => {});
    }
    await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`ingest:${provider}:${scope}`]).catch(() => {});
    lockClient.release();
  }
}
