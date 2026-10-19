// Q4: ¿resuelve GLEIF LEI -> ISIN? Prueba a mano con 4 LEI de la muestra (fixtures/esef/gleif/).
import { get } from './http.ts';

const cases: Record<string, string> = { 'NOVO-B.CO': '549300DAQ1CVT6CXN342', 'VOLV-B.ST': '549300HGV012CNC8JD22', 'SHEL.LSE': '21380068P1DRHMJ8KU70', 'ITX.MC': '549300TTCXZOGZM2EY83' };
for (const [sym, lei] of Object.entries(cases)) {
  const r = await get(`https://api.gleif.org/api/v1/lei-records/${lei}/isins?page[size]=50`, `fixtures/esef/gleif/${lei}.json`);
  let txt = r.body.slice(0, 160);
  try { const j = JSON.parse(r.body); txt = `${j.data.length} ISIN: ${j.data.map((d: any) => d.attributes.isin).join(', ')} | total=${j.meta?.pagination?.total}`; } catch { /* cuerpo no JSON */ }
  console.log(sym, lei, 'HTTP', r.status, r.ms + 'ms', txt);
}
