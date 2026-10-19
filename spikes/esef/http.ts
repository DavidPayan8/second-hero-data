// Spike ESEF: cliente HTTP mínimo con cortesía (≤1 petición/s) y registro de tiempos. De usar y tirar.
import 'dotenv/config';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const BASE = 'https://filings.xbrl.org';
const MIN_GAP_MS = 1100;
let last = 0;

export function userAgent(): string {
  const ua = (process.env.SEC_USER_AGENT ?? '').trim();
  if (!ua) throw new Error('Falta SEC_USER_AGENT en .env');
  return ua;
}

export interface Got {
  status: number;
  ms: number;
  bytes: number;
  body: string;
  headers: Record<string, string>;
}

// Una petición por segundo como máximo; cada llamada queda en fixtures/esef/requests.log (url, estado, ms, bytes).
export async function get(url: string, saveTo?: string): Promise<Got> {
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' } });
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Date.now() - t0;
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  await mkdir('fixtures/esef', { recursive: true });
  await appendFile('fixtures/esef/requests.log', `${new Date().toISOString()}\t${res.status}\t${ms}ms\t${buf.length}B\t${url}\n`);
  if (saveTo && res.ok) {
    await mkdir(dirname(saveTo), { recursive: true });
    await writeFile(saveTo, buf);
  }
  return { status: res.status, ms, bytes: buf.length, body: buf.toString('utf8'), headers };
}
