import { config } from '../config.js';
import type { FetchResult } from '../eodhd/client.js';
import type { Job } from '../eodhd/jobs.js';
import { requireSecUserAgent } from '../sec/client.js';
import { ESEF_CONFIG, ESEF_FILING_ENDPOINT, ESEF_INDEX_ENDPOINT } from './config.js';

// El User-Agent de ESEF es el de la SEC (SEC_USER_AGENT de .env): no hay variable nueva.
export const requireEsefUserAgent = (userAgent: string = config.secUserAgent) => requireSecUserAgent(userAgent);

export const indexPageJob = (page: number, size: number = ESEF_CONFIG.indexPageSize): Job =>
  ({ endpoint: ESEF_INDEX_ENDPOINT, params: { page: String(page), size: String(size) }, cost: 1 });

// Atributos del índice que se guardan con la llamada (raw_payload.params): lo que el extractor necesita de la presentación y que
// no está dentro del xBRL-JSON. Todo texto, tal como lo da el índice; los nulos no se guardan.
export interface IndexFiling {
  fxo_id: string;
  lei: string;
  json_url: string;
  country: string | null;
  period_end: string | null;
  processed: string | null;
  date_added: string | null;
  error_count: number | null;
  warning_count: number | null;
  inconsistency_count: number | null;
  sha256: string | null;
  report_url: string | null;
  viewer_url: string | null;
}

export function filingJob(f: IndexFiling): Job {
  const params: Record<string, string> = { fxo_id: f.fxo_id, lei: f.lei, json_url: f.json_url };
  for (const k of ['country', 'period_end', 'processed', 'date_added', 'error_count', 'warning_count', 'inconsistency_count', 'sha256', 'report_url', 'viewer_url'] as const) {
    if (f[k] !== null && f[k] !== undefined) params[k] = String(f[k]);
  }
  return { endpoint: ESEF_FILING_ENDPOINT, symbol: f.lei, params, cost: 1 };
}

// Llamada de un trabajo de ESEF. Sin token; solo exige un User-Agent con contacto.
export function esefFetcher(options: { userAgent: string; baseUrl?: string; timeoutMs?: number }): (job: Job) => Promise<FetchResult> {
  const base = (options.baseUrl ?? ESEF_CONFIG.base).replace(/\/+$/, '');
  return async (job) => {
    let url: string;
    if (job.endpoint === ESEF_INDEX_ENDPOINT) url = `${base}/api/filings?page[size]=${job.params.size}&page[number]=${job.params.page}&include=entity&sort=processed`;
    else if (job.endpoint === ESEF_FILING_ENDPOINT) url = `${base}${job.params.json_url}`;
    else throw new Error(`Endpoint de ESEF desconocido: ${job.endpoint}`);
    try {
      // Los informes pesan hasta decenas de MB: el plazo es el doble del de EODHD.
      const res = await fetch(url, {
        headers: { 'User-Agent': options.userAgent, 'Accept-Encoding': 'gzip, deflate' },
        signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs * 2),
        redirect: 'error',
      });
      return { kind: 'response', status: res.status, body: Buffer.from(await res.arrayBuffer()), fetchedAt: new Date() };
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string } };
      return { kind: 'transport_error', error: [e.name ?? 'Error', e.message ?? String(err), e.cause?.code ? `(${e.cause.code})` : ''].filter(Boolean).join(': '), fetchedAt: new Date() };
    }
  };
}
