import { config } from '../config.js';

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export function clientOptions(overrides: Partial<ClientOptions> = {}): ClientOptions {
  return { apiKey: config.eodhdApiKey, baseUrl: config.eodhdBase, timeoutMs: config.timeoutMs, ...overrides };
}

// Resultado de una llamada. Con respuesta (cualquier estado HTTP, 4xx y 5xx incluidos) lleva los BYTES exactos del
// cuerpo, sin decodificar. Sin respuesta (timeout, conexión cortada, DNS, cuerpo truncado) lleva solo el error.
export type FetchResult =
  | { kind: 'response'; status: number; body: Buffer; fetchedAt: Date }
  | { kind: 'transport_error'; error: string; fetchedAt: Date };

// El api_token va en la URL porque así lo exige la API, pero NUNCA sale de este módulo: ni en el resultado, ni en los
// mensajes de error (se enmascara si aparece), ni en lo que se persiste.
function describeError(err: unknown, apiKey: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const parts = [e.name ?? 'Error', e.message ?? String(err)];
  if (e.cause?.code) parts.push(`(${e.cause.code})`);
  else if (e.cause?.message) parts.push(`(${e.cause.message})`);
  const text = parts.join(': ').replace(': (', ' (');
  return apiKey ? text.split(apiKey).join('***') : text;
}

export async function fetchRaw(path: string, params: Record<string, string>, opts: ClientOptions): Promise<FetchResult> {
  if (!opts.apiKey) throw new Error('Falta EODHD_API_KEY en .env');
  if ('api_token' in params) throw new Error('api_token no puede ir en params: lo añade el cliente');
  const qs = new URLSearchParams({ ...params, fmt: 'json', api_token: opts.apiKey });
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/${path}?${qs}`;
  try {
    // redirect: 'error' evita que el token viaje a otro destino si el servidor redirige.
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs), redirect: 'error' });
    const body = Buffer.from(await res.arrayBuffer());
    return { kind: 'response', status: res.status, body, fetchedAt: new Date() };
  } catch (err) {
    return { kind: 'transport_error', error: describeError(err, opts.apiKey), fetchedAt: new Date() };
  }
}
