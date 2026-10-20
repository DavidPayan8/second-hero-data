// Resumen de compress-out.json y extrapolación a los informes (LEI, cierre) del índice entre 2021-01 y 2026-06.
import { readdir, readFile } from 'node:fs/promises';
const rows: any[] = JSON.parse(await readFile('fixtures/esef/compress-out.json', 'utf8'));
const M = ['gzip9', 'brotli11', 'zstd19'];
const mb = (x: number) => (x / 1e6).toFixed(2);
const grp = (name: string, rs: any[]) => {
  const raw = rs.reduce((a, r) => a + r.raw, 0);
  console.log(`\n${name} (${rs.length} informes) bruto total ${mb(raw)} MB, medio ${mb(raw / rs.length)} MB, mediano ${mb(rs.map((r) => r.raw).sort((a, b) => a - b)[Math.floor(rs.length / 2)])} MB`);
  for (const m of M) {
    const c = rs.reduce((a, r) => a + r[`${m}_bytes`], 0), cm = rs.reduce((a, r) => a + r[`${m}_cms`], 0), dm = rs.reduce((a, r) => a + r[`${m}_dms`], 0);
    console.log(`  ${m}: ${mb(c)} MB (${(100 * c / raw).toFixed(1)} %, ratio ${(raw / c).toFixed(1)}x), medio ${mb(c / rs.length)} MB, compresión ${(cm / 1000).toFixed(1)} s (${(cm / rs.length).toFixed(0)} ms/inf.; ${(raw / 1e6 / (cm / 1000)).toFixed(1)} MB/s), descompresión ${(dm / 1000).toFixed(2)} s (${(dm / rs.length).toFixed(0)} ms/inf.; ${(raw / 1e6 / (dm / 1000)).toFixed(0)} MB/s)`);
  }
  return { n: rs.length, raw, mean: raw / rs.length, c: Object.fromEntries(M.map((m) => [m, rs.reduce((a, r) => a + r[`${m}_bytes`], 0) / rs.length])) };
};
const old = rows.filter((r) => r.fxo.includes('-2021-'));
const neu = rows.filter((r) => !r.fxo.includes('-2021-'));
const a = grp('Todos', rows); const o = grp('Primer ejercicio (cierre 2021)', old); const n = grp('Posteriores', neu);
// Recuento de informes en el índice
const dir = 'fixtures/esef/filings'; const ent = new Map<string, string>(); const g = new Map<string, string>();
for (const f of (await readdir(dir)).filter((x) => x.startsWith('p1000-')).sort()) {
  const j = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
  for (const e of j.included ?? []) ent.set(e.id, e.attributes.identifier);
  for (const d of j.data) if (d.attributes.country !== 'UA') { const pe = d.attributes.period_end; if (pe >= '2021-01-01' && pe <= '2026-06-30') g.set(ent.get(d.relationships.entity.data.id) + '|' + pe, pe); }
}
const nOld = [...g.values()].filter((pe) => pe.startsWith('2021')).length; const nAll = g.size; const nNew = nAll - nOld;
console.log('\nPares (LEI, cierre) 2021-01..2026-06 sin UA:', nAll, '| cierre en 2021:', nOld, '| resto:', nNew);
for (const m of ['raw', ...M]) {
  const per = (x: any) => (m === 'raw' ? x.mean : x.c[m]);
  const tot = nOld * per(o) + nNew * per(n);
  console.log(`  ${m}: FY2021 ${(nOld * per(o) / 1e9).toFixed(2)} GB + resto ${(nNew * per(n) / 1e9).toFixed(2)} GB = ${(tot / 1e9).toFixed(1)} GB`);
}
