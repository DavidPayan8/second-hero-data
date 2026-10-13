import { config } from '../config.js';
import { capture, type CaptureSummary } from '../eodhd/ingest.js';
import type { FetchResult } from '../eodhd/client.js';
import type { Job } from '../eodhd/jobs.js';

// Captura de companyfacts de la SEC (data.sec.gov) con el mismo mecanismo que EODHD: una ingestion_run con provider 'sec', blob
// por hash y una raw_payload por llamada (endpoint 'companyfacts/{cik}', provider_symbol = CIK de 10 dígitos). Sin token; la SEC
// exige un User-Agent que identifique a quien llama y limita a 10 peticiones por segundo.
export const SEC_PROVIDER = 'sec';
export const SEC_ENDPOINT = 'companyfacts/{cik}';
// PROVISIONAL: pausa mínima entre el inicio de dos llamadas. 125 ms = 8 peticiones por segundo, por debajo del límite de 10.
export const SEC_MIN_INTERVAL_MS = 125;

const PLACEHOLDER = /ejemplo\.com|tu-email|example\.com/i;

// El runner se niega a llamar sin un User-Agent real (la SEC bloquea las peticiones anónimas y el valor de .env.example es un
// ejemplo, no un contacto).
export function requireSecUserAgent(userAgent: string = config.secUserAgent): string {
  const ua = userAgent.trim().replace(/^["']|["']$/g, '');
  if (!ua || PLACEHOLDER.test(ua)) throw new Error('Falta SEC_USER_AGENT en .env (nombre y contacto reales, p. ej. "Second hero contacto@dominio.com"): la SEC exige identificar a quien llama');
  return ua;
}

export const cik10 = (cik: string) => cik.replace(/\D/g, '').padStart(10, '0');

export function secJobs(ciks: string[]): Job[] {
  return [...new Set(ciks.map(cik10))].map((cik) => ({ endpoint: SEC_ENDPOINT, symbol: cik, params: { cik }, cost: 1 }));
}

export function secFetcher(options: { userAgent: string; baseUrl?: string; timeoutMs?: number }): (job: Job) => Promise<FetchResult> {
  const base = (options.baseUrl ?? config.secBase).replace(/\/+$/, '');
  return async (job) => {
    const cik = job.symbol ?? job.params.cik;
    if (!cik) throw new Error(`${job.endpoint} necesita un CIK`);
    try {
      const res = await fetch(`${base}/api/xbrl/companyfacts/CIK${cik10(cik)}.json`, {
        headers: { 'User-Agent': options.userAgent, 'Accept-Encoding': 'gzip, deflate' },
        signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs),
        redirect: 'error',
      });
      return { kind: 'response', status: res.status, body: Buffer.from(await res.arrayBuffer()), fetchedAt: new Date() };
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string } };
      return { kind: 'transport_error', error: [e.name ?? 'Error', e.message ?? String(err), e.cause?.code ? `(${e.cause.code})` : ''].filter(Boolean).join(': '), fetchedAt: new Date() };
    }
  };
}

export async function captureSec(ciks: string[], options: { scope?: string; userAgent?: string; baseUrl?: string; minIntervalMs?: number; log?: (m: string) => void } = {}): Promise<CaptureSummary> {
  const userAgent = requireSecUserAgent(options.userAgent);
  const jobs = secJobs(ciks);
  return capture(options.scope ?? 'companyfacts', jobs, {
    provider: SEC_PROVIDER, fetcher: secFetcher({ userAgent, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) }),
    minIntervalMs: options.minIntervalMs ?? SEC_MIN_INTERVAL_MS, budget: jobs.length, maxAttempts: 1, ...(options.log ? { log: options.log } : {}),
  });
}
