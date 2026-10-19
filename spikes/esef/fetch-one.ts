// Descarga el xBRL-JSON de un informe del índice por fxo_id.
import { readdir, readFile } from 'node:fs/promises';
import { BASE, get } from './http.ts';

export async function findFiling(fxo: string): Promise<any> {
  const dir = 'fixtures/esef/filings';
  for (const f of (await readdir(dir)).filter((x) => x.startsWith('p1000-')).sort()) {
    const j = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
    const hit = j.data.find((d: any) => d.attributes.fxo_id === fxo);
    if (hit) return hit.attributes;
  }
  throw new Error('no está en el índice: ' + fxo);
}

if (process.argv[1]?.endsWith('fetch-one.ts')) {
  const fxo = process.argv[2];
  const a = await findFiling(fxo);
  const r = await get(BASE + a.json_url, `fixtures/esef/json/${fxo}.json`);
  console.log(fxo, r.status, r.ms + 'ms', r.bytes + 'B', r.headers['content-type'], r.headers['content-encoding'] ?? '');
}
