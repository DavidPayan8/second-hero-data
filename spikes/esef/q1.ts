// Q1: cobertura y duplicados a partir del índice descargado por harvest.ts.
import { readdir, readFile } from 'node:fs/promises';

const dir = 'fixtures/esef/filings';
const files = (await readdir(dir)).filter((f) => f.startsWith('p1000-')).sort();
const filings: any[] = [];
const entities = new Map<string, any>();
for (const f of files) {
  const j = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
  for (const d of j.data) filings.push(d);
  for (const e of j.included ?? []) entities.set(e.id, e);
}
console.log('filings', filings.length, 'entidades', entities.size);
console.log('atributos filing:', Object.keys(filings[0].attributes).join(', '));
console.log('atributos entity:', Object.keys([...entities.values()][0].attributes).join(', '));
console.log('relaciones filing:', Object.keys(filings[0].relationships).join(', '));
const nulls: Record<string, number> = {};
for (const f of filings) for (const [k, v] of Object.entries(f.attributes)) if (v == null) nulls[k] = (nulls[k] ?? 0) + 1;
console.log('nulos por atributo:', JSON.stringify(nulls));

const ent = (f: any) => entities.get(f.relationships.entity.data.id);
const year = (f: any) => Number(String(f.attributes.period_end).slice(0, 4));

// País × año de period_end. FY = año de period_end salvo cierre en enero-febrero, que se asigna al año anterior (ver informe).
const table: Record<string, Record<string, number>> = {};
for (const f of filings) {
  const c = f.attributes.country ?? '??';
  const y = String(year(f));
  (table[c] ??= {})[y] = (table[c][y] ?? 0) + 1;
}
const countries = Object.keys(table).sort();
const years = ['2019', '2020', '2021', '2022', '2023', '2024', '2025'];
console.log(['país', ...years, 'total'].join('\t'));
for (const c of countries) {
  const tot = Object.values(table[c]).reduce((a, b) => a + b, 0);
  console.log([c, ...years.map((y) => table[c][y] ?? 0), tot].join('\t'));
}
console.log('rango period_end:', filings.map((f) => f.attributes.period_end).sort()[0], filings.map((f) => f.attributes.period_end).sort().at(-1));

// Duplicados
const bySha = new Map<string, any[]>();
const byKey = new Map<string, any[]>();
for (const f of filings) {
  (bySha.get(f.attributes.sha256 ?? 'null') ?? bySha.set(f.attributes.sha256 ?? 'null', []).get(f.attributes.sha256 ?? 'null')!).push(f);
  const k = `${ent(f).attributes.identifier}|${f.attributes.period_end}`;
  (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(f);
}
console.log('sha256 repetidos:', [...bySha.entries()].filter(([k, v]) => k !== 'null' && v.length > 1).length, 'sha null:', bySha.get('null')?.length ?? 0);
const dupKeys = [...byKey.values()].filter((v) => v.length > 1);
console.log('(entidad, period_end) con >1 informe:', dupKeys.length);
for (const v of dupKeys.slice(0, 6)) console.log('  ', v.map((f) => `${f.attributes.fxo_id}|${f.attributes.country}|err=${f.attributes.error_count}|${f.attributes.processed}`).join('\n   '));
const dupByCountry: Record<string, number> = {};
for (const v of dupKeys) dupByCountry[v[0].attributes.country] = (dupByCountry[v[0].attributes.country] ?? 0) + 1;
console.log('duplicados por país:', JSON.stringify(dupByCountry));
// ¿fxo_id codifica país e idioma? patrón LEI-fecha-ESEF-PAIS-n
const sample = filings.filter((f) => ['ES', 'DE', 'GB'].includes(f.attributes.country)).slice(0, 3);
for (const f of sample) console.log('muestra fxo_id:', f.attributes.fxo_id, '| identifier:', ent(f).attributes.identifier, '| json_url:', f.attributes.json_url, '| package_url:', f.attributes.package_url);
// distribución errores
const errs = filings.map((f) => f.attributes.error_count ?? 0);
console.log('con error_count>0:', errs.filter((e) => e > 0).length, 'de', errs.length);
const ids = new Set(filings.map((f) => ent(f).attributes.identifier));
const leiLike = [...ids].filter((i) => /^[A-Z0-9]{20}$/.test(i)).length;
console.log('identifier con forma LEI (20 car.):', leiLike, 'de', ids.size);
