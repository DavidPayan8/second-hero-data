// Q2/Q3: descarga el xBRL-JSON del primer y el último ejercicio anual (desde 2021) de cada empresa de la muestra.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { BASE, get } from './http.ts';

const HOME: Record<string, string> = { 'ITX.MC': 'ES', 'SAN.MC': 'ES', 'IBE.MC': 'ES', 'MC.PA': 'FR', 'TTE.PA': 'FR', 'AIR.PA': 'NL', 'ASML.AS': 'NL', 'ENEL.MI': 'IT', 'NOVO-B.CO': 'DK', 'VOLV-B.ST': 'SE', 'NOKIA.HE': 'FI' };
const sample = JSON.parse(await readFile('fixtures/esef/sample.json', 'utf8'));
// Un índice rápido fxo_id -> json_url
const idx = new Map<string, string | null>();
for (let p = 1; p <= 27; p++) {
  const j = JSON.parse(await readFile(`fixtures/esef/filings/p1000-${String(p).padStart(3, '0')}.json`, 'utf8'));
  for (const d of j.data) idx.set(d.attributes.fxo_id, d.attributes.json_url);
}
const chosen: string[] = [];
for (const [sym, ents] of Object.entries<any[]>(sample)) {
  const e = ents.find((x) => x.filings.length > 3 && !/fonden/i.test(x.name)) ?? ents[0];
  if (!e) continue;
  let fs = e.filings.filter((f: any) => f.pe >= '2021-01-01' && f.pe <= '2026-01-01' && f.json);
  if (sym === 'NOVO-B.CO') fs = fs.filter((f: any) => f.pe.endsWith('-12-31'));
  // un informe por fecha de cierre: menos errores primero, país de origen preferido
  const byPe = new Map<string, any>();
  for (const f of fs) {
    const cur = byPe.get(f.pe);
    const better = !cur || f.err < cur.err || (f.err === cur.err && f.c === HOME[sym] && cur.c !== HOME[sym]);
    if (better) byPe.set(f.pe, f);
  }
  const list = [...byPe.values()].sort((a, b) => a.pe.localeCompare(b.pe));
  const pick = list.length > 1 ? [list[0], list.at(-1)] : list;
  for (const f of pick) chosen.push(f.fxo_id);
}
console.log(chosen.length, 'informes a descargar');
for (const fxo of chosen) {
  const file = `fixtures/esef/json/${fxo}.json`;
  if (existsSync(file)) continue;
  const r = await get(BASE + idx.get(fxo), file);
  console.log(fxo, r.status, r.ms + 'ms', (r.bytes / 1e6).toFixed(1) + 'MB');
}
