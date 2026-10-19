// Q1: baja todo el índice de filings (con entity incluida) a fixtures/esef/filings/. Prueba tamaños de página.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { BASE, get } from './http.ts';

const size = Number(process.argv[2] ?? 500);
const dir = 'fixtures/esef/filings';

// Sondeo de tamaño máximo de página (solo cuenta filas devueltas).
if (process.argv[3] === 'probe') {
  for (const s of [100, 500, 1000, 5000]) {
    const r = await get(`${BASE}/api/filings?page[size]=${s}&page[number]=1&fields[filing]=fxo_id`);
    let n = -1;
    try { n = JSON.parse(r.body).data.length; } catch { /* cuerpo no JSON */ }
    console.log(`size=${s} -> HTTP ${r.status}, filas=${n}, ${r.ms}ms, ${r.bytes}B`);
  }
  process.exit(0);
}

let page = 1;
let pages = Infinity;
while (page <= pages) {
  const file = `${dir}/p${size}-${String(page).padStart(3, '0')}.json`;
  let body: string;
  if (existsSync(file)) body = await readFile(file, 'utf8');
  else {
    const r = await get(`${BASE}/api/filings?page[size]=${size}&page[number]=${page}&include=entity&sort=processed`, file);
    if (r.status !== 200) { console.log(`HTTP ${r.status} en página ${page}: ${r.body.slice(0, 200)}`); break; }
    body = r.body;
    console.log(`página ${page}: ${r.ms}ms ${r.bytes}B`);
  }
  const j = JSON.parse(body);
  pages = Math.ceil(j.meta.count / size);
  page++;
}
console.log(`listo: ${pages} páginas de ${size}`);
