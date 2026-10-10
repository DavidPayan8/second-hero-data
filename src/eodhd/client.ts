import { createHash } from 'node:crypto';
import { config } from '../config.js';

export interface RawResponse {
  url: string; // SIN api_token
  status: number;
  fetchedAt: string;
  sha256: string;
  body: string; // cuerpo HTTP exacto
}

export async function fetchRaw(path: string, params: Record<string, string> = {}): Promise<RawResponse> {
  if (!config.eodhdApiKey) throw new Error('Falta EODHD_API_KEY en .env');
  const qs = new URLSearchParams({ ...params, fmt: 'json' });
  const publicUrl = `${config.eodhdBase}/${path}?${qs}`;
  qs.set('api_token', config.eodhdApiKey);
  const res = await fetch(`${config.eodhdBase}/${path}?${qs}`);
  const body = await res.text();
  return {
    url: publicUrl,
    status: res.status,
    fetchedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(body).digest('hex'),
    body,
  };
}
