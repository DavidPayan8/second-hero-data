// Muestra: localiza cada empresa en el índice por nombre de entidad (los LEI se leen del índice, no de memoria).
import { readdir, readFile, writeFile } from 'node:fs/promises';

const names: Record<string, RegExp> = {
  'ITX.MC': /industria de dise.o textil/i, 'SAN.MC': /banco santander/i, 'IBE.MC': /iberdrola/i,
  'SAP.XETRA': /^sap se/i, 'SIE.XETRA': /^siemens (ag|aktieng)/i, 'ALV.XETRA': /^allianz se/i,
  'MC.PA': /lvmh|louis vuitton/i, 'TTE.PA': /totalenergies/i, 'AIR.PA': /^airbus/i,
  'ASML.AS': /^asml/i, 'ENEL.MI': /^enel\b/i,
  'NOVO-B.CO': /novo nordisk/i, 'VOLV-B.ST': /^aktiebolaget volvo/i, 'NOKIA.HE': /nokia/i,
  'SHEL.LSE': /^shell/i, 'AZN.LSE': /astrazeneca/i, 'ULVR.LSE': /^unilever/i, 'BP.LSE': /^bp (p\.l\.c|plc)/i, 'HSBA.LSE': /hsbc holdings/i,
};
const dir = 'fixtures/esef/filings';
const ents = new Map<string, any>();
const byEnt = new Map<string, any[]>();
for (const f of (await readdir(dir)).filter((x) => x.startsWith('p1000-')).sort()) {
  const j = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
  for (const e of j.included ?? []) ents.set(e.id, e);
  for (const d of j.data) { const id = d.relationships.entity.data.id; (byEnt.get(id) ?? byEnt.set(id, []).get(id)!).push(d); }
}
const out: Record<string, any[]> = {};
for (const [sym, re] of Object.entries(names)) {
  const hits = [...ents.values()].filter((e) => re.test(e.attributes.name));
  out[sym] = hits.map((e) => ({
    id: e.id, identifier: e.attributes.identifier, name: e.attributes.name,
    filings: (byEnt.get(e.id) ?? []).map((d) => ({ fxo_id: d.attributes.fxo_id, pe: d.attributes.period_end, c: d.attributes.country, err: d.attributes.error_count, json: !!d.attributes.json_url })),
  }));
  console.log(sym, '->', hits.length ? hits.map((e) => `${e.attributes.identifier} "${e.attributes.name}" (${byEnt.get(e.id)?.length ?? 0} inf.)`).join(' | ') : 'NO ENCONTRADA');
}
await writeFile('fixtures/esef/sample.json', JSON.stringify(out, null, 1));
