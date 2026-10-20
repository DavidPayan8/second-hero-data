import { pool } from '../db/pool.js';
import { capture, type CaptureSummary } from '../eodhd/ingest.js';
import type { Job } from '../eodhd/jobs.js';
import { esefFetcher, filingJob, indexPageJob, requireEsefUserAgent, type IndexFiling } from './client.js';
import { compressBody, decodeBody, ESEF_BODY_FORMAT } from './codec.js';
import { ESEF_CONFIG, ESEF_FILING_ENDPOINT, ESEF_INDEX_ENDPOINT, ESEF_INDEX_SCOPE } from './config.js';

// Captura de ESEF/UKSEF (filings.xbrl.org) con el mismo mecanismo que la SEC: una ingestion_run con provider 'esef', una
// raw_payload por llamada y el cuerpo en payload_blob comprimido con zstd (hash = sha256 del cuerpo sin comprimir).
// Dos modos, pensados para la carga completa:
//  - índice: baja el índice entero una vez (endpoint 'filings-index', una raw_payload por página). Es la foto de referencia.
//  - lote: baja informes (endpoint 'filing-json') de esa foto, filtrando por país, año o LEI. Una ingestion_run por lote.
//    Es reanudable: se salta cualquier informe cuyo json_url ya tenga una raw_payload con http 200.
// Qué versión de cada (LEI, cierre) vale NO se decide aquí ni se guarda: se calcula siempre sobre todo lo capturado (choose.ts).

interface CaptureCommon {
  userAgent?: string;
  baseUrl?: string;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  signal?: AbortSignal;
}

// Intentos por trabajo (cada intento gasta un punto del presupuesto de la corrida; sin cuota real, el tope es jobs × intentos).
const MAX_ATTEMPTS = 2;

const common = (o: CaptureCommon, userAgent: string, jobsLen: number) => ({
  provider: ESEF_CONFIG.provider,
  fetcher: esefFetcher({ userAgent, ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}) }),
  encodeBody: (body: Buffer) => ({ body: compressBody(body), format: ESEF_BODY_FORMAT }),
  minIntervalMs: o.minIntervalMs ?? ESEF_CONFIG.minIntervalMs,
  budget: jobsLen * MAX_ATTEMPTS,
  maxAttempts: MAX_ATTEMPTS,
  ...(o.log ? { log: o.log } : {}),
  ...(o.sleep ? { sleep: o.sleep } : {}),
  ...(o.now ? { now: o.now } : {}),
  ...(o.signal ? { signal: o.signal } : {}),
});

// ---------------------------------------------------------------------------------------------------------------- índice

// Número de páginas del índice (una llamada ligera que no se guarda: solo lee meta.count).
async function indexPageCount(userAgent: string, baseUrl: string | undefined, size: number): Promise<number> {
  const r = await esefFetcher({ userAgent, ...(baseUrl ? { baseUrl } : {}) })({ endpoint: ESEF_INDEX_ENDPOINT, params: { page: '1', size: '1' }, cost: 1 });
  if (r.kind !== 'response' || r.status !== 200) throw new Error(`No se pudo leer el tamaño del índice: ${r.kind === 'response' ? `HTTP ${r.status}` : r.error}`);
  const count = (JSON.parse(r.body.toString('utf8')) as { meta?: { count?: number } }).meta?.count;
  if (typeof count !== 'number') throw new Error('El índice no trae meta.count');
  return Math.ceil(count / size);
}

export function indexJobs(pages: number, size: number = ESEF_CONFIG.indexPageSize): Job[] {
  return Array.from({ length: pages }, (_, i) => indexPageJob(i + 1, size));
}

export async function captureIndex(options: CaptureCommon & { pages?: number } = {}): Promise<CaptureSummary> {
  const userAgent = requireEsefUserAgent(options.userAgent);
  const pages = options.pages ?? await indexPageCount(userAgent, options.baseUrl, ESEF_CONFIG.indexPageSize);
  // El sondeo y la primera página no pueden ir pegados: se respeta la pausa mínima también entre ellos.
  await (options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(options.minIntervalMs ?? ESEF_CONFIG.minIntervalMs);
  const jobs = indexJobs(pages);
  const summary = await capture(ESEF_INDEX_SCOPE, jobs, common(options, userAgent, jobs.length));
  // Las páginas del índice no tienen escritor propio: se dan por leídas, y así quedan fuera de cualquier cola de pendientes.
  await pool.query("UPDATE raw_payload SET parse_status = 'ok' WHERE ingestion_run_id = $1 AND endpoint = $2 AND http_status = 200 AND parse_status = 'pending'", [summary.runId, ESEF_INDEX_ENDPOINT]);
  return summary;
}

// Foto de referencia: la última corrida de índice terminada ('ok'). Lee sus páginas y devuelve las presentaciones con su LEI.
export async function readIndexPhoto(): Promise<{ runId: string; filings: IndexFiling[]; withoutEntity: number }> {
  const run = (await pool.query<{ id: string }>(
    "SELECT ingestion_run_id AS id FROM ingestion_run WHERE provider = $1 AND scope = $2 AND status = 'ok' ORDER BY ingestion_run_id DESC LIMIT 1",
    [ESEF_CONFIG.provider, ESEF_INDEX_SCOPE])).rows[0];
  if (!run) throw new Error('No hay ninguna foto del índice terminada: ejecuta primero `npm run esef-capture -- --index --go`');
  const pagesRows = (await pool.query<{ page: string; body: Buffer; body_format: string }>(
    `SELECT DISTINCT ON (rp.params->>'page') rp.params->>'page' AS page, b.body, b.body_format
     FROM raw_payload rp JOIN payload_blob b USING (content_hash)
     WHERE rp.ingestion_run_id = $1 AND rp.endpoint = $2 AND rp.http_status = 200 AND b.body IS NOT NULL
     ORDER BY rp.params->>'page', rp.raw_payload_id DESC`, [run.id, ESEF_INDEX_ENDPOINT])).rows;
  return { runId: run.id, ...parseIndexPages(pagesRows.map((r) => decodeBody(r.body, r.body_format))) };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

// Páginas JSON:API del índice (con la entidad incluida) -> presentaciones. Una presentación sin entidad o sin json_url no sirve.
export function parseIndexPages(bodies: Buffer[]): { filings: IndexFiling[]; withoutEntity: number } {
  const filings: IndexFiling[] = [];
  let withoutEntity = 0;
  for (const body of bodies) {
    const page = JSON.parse(body.toString('utf8')) as { data: any[]; included?: any[] };
    const lei = new Map<string, string>();
    for (const e of page.included ?? []) if (e.type === 'entity') lei.set(String(e.id), String(e.attributes?.identifier ?? ''));
    for (const d of page.data) {
      const a = d.attributes ?? {};
      const id = lei.get(String(d.relationships?.entity?.data?.id));
      const jsonUrl = str(a.json_url);
      if (!id || !str(a.fxo_id)) { withoutEntity++; continue; }
      if (!jsonUrl) continue; // sin xBRL-JSON no hay nada que descargar
      filings.push({
        fxo_id: a.fxo_id, lei: id, json_url: jsonUrl, country: str(a.country), period_end: str(a.period_end), processed: str(a.processed), date_added: str(a.date_added),
        error_count: int(a.error_count), warning_count: int(a.warning_count), inconsistency_count: int(a.inconsistency_count), sha256: str(a.sha256),
        report_url: str(a.report_url), viewer_url: str(a.viewer_url),
      });
    }
  }
  return { filings, withoutEntity };
}

// ----------------------------------------------------------------------------------------------------------------- lote

export interface BatchFilters {
  countries?: string[]; // --country=ES,GB
  years?: string[]; // --year=2023 (año del period_end del ÍNDICE: es un prefiltro, el cierre real sale de los hechos)
  leis?: string[]; // --leis=...
  limit?: number;
  today?: string; // YYYY-MM-DD: un cierre posterior no es un informe (el índice trae cierres de 2031)
}

export interface BatchPlan {
  indexRunId: string;
  scope: string;
  candidates: number; // presentaciones de la foto que cumplen los filtros
  alreadyCaptured: number; // con json_url que ya tiene una raw_payload con http 200
  jobs: Job[];
}

export const batchScope = (f: BatchFilters): string => {
  const parts = [
    f.countries?.length ? `country=${[...f.countries].sort().join(',')}` : '',
    f.years?.length ? `year=${[...f.years].sort().join(',')}` : '',
    f.leis?.length ? `leis=${f.leis.length}:${[...f.leis].sort()[0]}` : '',
    f.limit ? `limit=${f.limit}` : '',
  ].filter(Boolean);
  return `batch:${parts.join(';') || 'all'}`;
};

export async function planBatch(filters: BatchFilters = {}, photo?: { runId: string; filings: IndexFiling[] }): Promise<BatchPlan> {
  const { runId, filings } = photo ?? await readIndexPhoto();
  const today = filters.today ?? new Date().toISOString().slice(0, 10);
  const countries = filters.countries?.map((c) => c.toUpperCase());
  const leis = filters.leis?.map((l) => l.toUpperCase());
  const excluded = new Set<string>(ESEF_CONFIG.excludedCountries);
  const pick = filings.filter((f) =>
    !(f.country && excluded.has(f.country))
    && (!countries || (f.country !== null && countries.includes(f.country)))
    && (!leis || leis.includes(f.lei))
    && (f.period_end !== null && f.period_end >= ESEF_CONFIG.firstClose && f.period_end <= today)
    && (!filters.years?.length || filters.years.includes(f.period_end.slice(0, 4))))
    .sort((a, b) => (a.country ?? '').localeCompare(b.country ?? '') || a.lei.localeCompare(b.lei) || a.period_end!.localeCompare(b.period_end!) || a.fxo_id.localeCompare(b.fxo_id));
  const done = new Set((await pool.query<{ u: string }>(
    `SELECT DISTINCT rp.params->>'json_url' AS u FROM raw_payload rp JOIN ingestion_run r USING (ingestion_run_id)
     WHERE r.provider = $1 AND rp.endpoint = $2 AND rp.http_status = 200`, [ESEF_CONFIG.provider, ESEF_FILING_ENDPOINT])).rows.map((r) => r.u));
  const todo = pick.filter((f) => !done.has(f.json_url));
  const limited = filters.limit ? todo.slice(0, filters.limit) : todo;
  return { indexRunId: runId, scope: batchScope(filters), candidates: pick.length, alreadyCaptured: pick.length - todo.length, jobs: limited.map(filingJob) };
}

export async function captureBatch(filters: BatchFilters = {}, options: CaptureCommon & { photo?: { runId: string; filings: IndexFiling[] } } = {}): Promise<CaptureSummary & { plan: Omit<BatchPlan, 'jobs'> & { jobs: number } }> {
  const userAgent = requireEsefUserAgent(options.userAgent);
  const plan = await planBatch(filters, options.photo);
  const summary = await capture(plan.scope, plan.jobs, common(options, userAgent, plan.jobs.length));
  return { ...summary, plan: { ...plan, jobs: plan.jobs.length } };
}
