// Q1/Q2 (complemento): tipos de duplicado, fechas anómalas y volumen estimado de esef_fact.
import { readdir, readFile } from 'node:fs/promises';

const dir = 'fixtures/esef/filings';
const fl: any[] = []; const ent = new Map<string, any>();
for (const f of (await readdir(dir)).filter((x) => x.startsWith('p1000-')).sort()) {
  const j = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
  fl.push(...j.data); for (const e of j.included ?? []) ent.set(e.id, e);
}
const lei = (f: any) => ent.get(f.relationships.entity.data.id).attributes.identifier;
const eu = fl.filter((f) => f.attributes.country !== 'UA');
const odd = eu.filter((f) => f.attributes.period_end < '2018-01-01' || f.attributes.period_end > '2026-12-31');
console.log('period_end fuera de 2018–2026 (sin UA):', odd.length, odd.slice(0, 3).map((f) => f.attributes.fxo_id + ' ' + f.attributes.period_end).join(' | '));
console.log('sin json_url (sin UA):', eu.filter((f) => !f.attributes.json_url).length, 'error_count>0:', eu.filter((f) => f.attributes.error_count > 0).length);
const g = new Map<string, any[]>();
for (const f of eu) { const k = lei(f) + '|' + f.attributes.period_end; (g.get(k) ?? g.set(k, []).get(k)!).push(f); }
let multi = 0, multiCountry = 0, sameCountry = 0, sameSha = 0, diffSha = 0;
for (const v of g.values()) {
  if (v.length < 2) continue; multi++;
  const cs = new Set(v.map((f) => f.attributes.country)); const shas = new Set(v.map((f) => f.attributes.sha256));
  if (cs.size > 1) multiCountry++; if (cs.size < v.length) sameCountry++;
  if (shas.size === 1) sameSha++; else diffSha++;
}
console.log({ gruposConMasDeUnInforme: multi, conVariosPaises: multiCountry, conVariasVersionesMismoPais: sameCountry, mismoSha: sameSha, shaDistinto: diffSha });
// Volumen: informes FY2021–FY2025 (period_end 2021-01-01..2026-06-30), sin UA, dedup por (LEI, period_end)
const inRange = [...g.entries()].filter(([k]) => { const pe = k.split('|')[1]; return pe >= '2021-01-01' && pe <= '2026-06-30'; });
const wc = new Set(['GB', 'ES', 'DE', 'FR', 'NL', 'IT', 'DK', 'SE', 'FI']);
console.log('grupos (LEI, period_end) 2021-01..2026-06:', inRange.length, '| solo países de la muestra:', inRange.filter(([, v]) => v.some((f) => wc.has(f.attributes.country))).length);
// Tablas de filas: media de hechos sin dimensiones por informe medida en la muestra (q23.json)
const q = JSON.parse(await readFile('fixtures/esef/q23.json', 'utf8'));
const nd = q.map((o: any) => o.nondim), nnd = q.map((o: any) => o.numericNondim), all = q.map((o: any) => o.facts);
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const old = q.filter((o: any) => o.fxo.includes('-2021-')), neu = q.filter((o: any) => !o.fxo.includes('-2021-'));
console.log('media hechos totales/sin dim/numéricos sin dim — 2021:', avg(old.map((o: any) => o.facts)).toFixed(0), avg(old.map((o: any) => o.nondim)).toFixed(0), avg(old.map((o: any) => o.numericNondim)).toFixed(0), '| posteriores:', avg(neu.map((o: any) => o.facts)).toFixed(0), avg(neu.map((o: any) => o.nondim)).toFixed(0), avg(neu.map((o: any) => o.numericNondim)).toFixed(0));
console.log('max sin dim:', Math.max(...nd), 'max total:', Math.max(...all), 'MB medio nuevos:', (avg(neu.map((o: any) => o.bytes)) / 1e6).toFixed(1));
const N = inRange.length, nNew = N * 0.8, nOld = N * 0.2;
const rowsNum = nNew * avg(neu.map((o: any) => o.numericNondim)) + nOld * avg(old.map((o: any) => o.numericNondim));
console.log('estimación filas esef_fact (numéricos sin dim, todos los informes del rango):', Math.round(rowsNum).toLocaleString('es'), '| solo 10 columnas de la tabla 6 (~2 periodos × ~12 conceptos candidatos):', Math.round(N * 24).toLocaleString('es'));
