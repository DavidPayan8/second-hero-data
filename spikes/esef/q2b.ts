// Q2 (detalle): tipos de valor, decimals ausentes, dimensiones, formato de valores, volumen estimado de esef_fact.
import { readdir, readFile } from 'node:fs/promises';

const dir = 'fixtures/esef/json';
const BASEDIM = new Set(['concept', 'entity', 'period', 'unit', 'language']);
const nonStr: Record<string, number> = {};
const noDec: Record<string, number> = {};
const axes: Record<string, number> = {};
const fmt = { exp: 0, comma: 0, neg: 0, plain: 0, nonNumericText: 0 };
let scaled = 0;
let inf = 0;
let ent = new Set<string>();
for (const f of (await readdir(dir)).sort()) {
  const j = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
  for (const x of Object.values<any>(j.facts)) {
    for (const k of Object.keys(x.dimensions)) if (!BASEDIM.has(k)) axes[k] = (axes[k] ?? 0) + 1;
    ent.add(x.dimensions.entity);
    if (typeof x.value !== 'string') { const t = x.value === null ? 'null' : typeof x.value; nonStr[t] = (nonStr[t] ?? 0) + 1; }
    if (x.decimals === undefined && x.dimensions.unit) { const c = String(x.dimensions.concept).split(':').pop()!; noDec[c] = (noDec[c] ?? 0) + 1; }
    if (x.decimals === 'INF') inf++;
    if (typeof x.value === 'string' && x.dimensions.unit) {
      if (/e/i.test(x.value)) fmt.exp++; else if (x.value.includes(',')) fmt.comma++; else if (x.value.startsWith('-')) fmt.neg++; else if (/^\d+(\.\d+)?$/.test(x.value)) fmt.plain++; else fmt.nonNumericText++;
    }
    if (x.dimensions.concept === 'ifrs-full:Assets' && !Object.keys(x.dimensions).some((k) => !BASEDIM.has(k))) { /* control de escala abajo */ }
  }
}
console.log('valores no-string por tipo:', JSON.stringify(nonStr));
console.log('numéricos sin decimals, por concepto (top):', JSON.stringify(Object.entries(noDec).sort((a, b) => b[1] - a[1]).slice(0, 8)));
console.log('decimals=INF:', inf);
console.log('formato valor numérico:', JSON.stringify(fmt));
console.log('ejes de dimensión más frecuentes:', JSON.stringify(Object.entries(axes).sort((a, b) => b[1] - a[1]).slice(0, 8)));
console.log('valores de entity distintos:', [...ent].length, [...ent].slice(0, 3).join(' '));
