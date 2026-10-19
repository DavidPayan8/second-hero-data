// Q2 (forma, volumen) y Q3 (conceptos de la tabla 6) sobre los xBRL-JSON descargados de la muestra.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';

const dir = 'fixtures/esef/json';
const BASEDIM = new Set(['concept', 'entity', 'period', 'unit', 'language']);

type Col = { std: string[]; alt: string[]; kind: 'flow' | 'stock'; kw: RegExp };
const COLS: Record<string, Col> = {
  revenue: { std: ['Revenue'], alt: ['RevenueFromContractsWithCustomers', 'InsuranceRevenue', 'InterestRevenueCalculatedUsingEffectiveInterestMethod', 'RevenueFromInterest', 'InterestIncomeExpense'], kind: 'flow', kw: /revenue|sales|turnover|ingres|ventas|nettoomsatt|omsaetning|chiffre/i },
  gross_profit: { std: ['GrossProfit'], alt: [], kind: 'flow', kw: /gross.?(profit|margin)|margenbruto/i },
  operating_income: { std: ['ProfitLossFromOperatingActivities'], alt: ['OperatingProfit'], kind: 'flow', kw: /operating.?(profit|income|result)|ebit\b|resultadoexplot/i },
  net_income: { std: ['ProfitLossAttributableToOwnersOfParent'], alt: ['ProfitLoss'], kind: 'flow', kw: /(net|profit|income).*(attributable|parent|owners|shareholders)|attributable/i },
  total_assets: { std: ['Assets'], alt: [], kind: 'stock', kw: /totalassets/i },
  total_liabilities: { std: ['Liabilities'], alt: [], kind: 'stock', kw: /totalliabilities/i },
  total_equity: { std: ['EquityAttributableToOwnersOfParent', 'Equity'], alt: [], kind: 'stock', kw: /(total)?equity/i },
  cash: { std: ['CashAndCashEquivalents'], alt: ['CashAndBankBalancesAtCentralBanks', 'CashAndCashEquivalentsAtEndOfPeriod'], kind: 'stock', kw: /cash.?and.?cash|cashequivalents/i },
  operating_cf: { std: ['CashFlowsFromUsedInOperatingActivities'], alt: ['CashFlowsFromUsedInOperatingActivitiesContinuingOperations'], kind: 'flow', kw: /operating.?activities|operatingcash/i },
  capex: { std: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'], alt: ['PurchaseOfPropertyPlantAndEquipment', 'PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets', 'PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities'], kind: 'flow', kw: /capex|capitalexpend|purchaseofproperty|acquisitionofproperty|investmentinproperty/i },
};

const day = (s: string) => Date.parse(s.slice(0, 10));
function parsePeriod(p: string): { start?: string; end: string } {
  const [a, b] = p.split('/');
  return b ? { start: a, end: b } : { end: a };
}
// En xBRL-JSON los fines de periodo y los instantes vienen como 00:00 del día siguiente al cierre.
const closeDay = (end: string) => new Date(day(end) - 86400000).toISOString().slice(0, 10);

const out: any[] = [];
for (const f of (await readdir(dir)).sort()) {
  const fxo = f.replace(/\.json$/, '');
  const size = (await stat(`${dir}/${f}`)).size;
  const j = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
  const facts: any[] = Object.values(j.facts);
  const nondim = facts.filter((x) => Object.keys(x.dimensions).every((k) => BASEDIM.has(k)));
  const num = nondim.filter((x) => x.dimensions.unit);
  // Periodo principal: último cierre de duración anual entre hechos numéricos sin dimensiones
  let mainEnd = '';
  for (const x of num) {
    const p = parsePeriod(x.dimensions.period);
    if (!p.start) continue;
    const d = (day(p.end) - day(p.start)) / 86400000;
    if (d >= 340 && d <= 380 && p.end > mainEnd) mainEnd = p.end;
  }
  const concepts = new Set(facts.map((x) => x.dimensions.concept));
  const prefixes: Record<string, number> = {};
  for (const x of facts) { const pre = String(x.dimensions.concept).split(':')[0]; prefixes[pre] = (prefixes[pre] ?? 0) + 1; }
  const stats = {
    fxo, bytes: size, facts: facts.length, nondim: nondim.length, numericNondim: num.length, concepts: concepts.size,
    taxonomy: Object.values(j.documentInfo.namespaces as Record<string, string>).filter((u) => u.includes('ifrs')).join(','),
    nonString: facts.filter((x) => typeof x.value !== 'string').length,
    noDecimals: num.filter((x) => x.decimals === undefined).length,
    decimalsSample: [...new Set(num.map((x) => x.decimals))].slice(0, 6),
    units: [...new Set(num.map((x) => x.dimensions.unit))].slice(0, 6),
    prefixes, mainEnd: mainEnd && closeDay(mainEnd),
  };
  const cols: Record<string, string> = {};
  const detail: Record<string, any> = {};
  for (const [col, def] of Object.entries(COLS)) {
    const at = (x: any) => {
      const p = parsePeriod(x.dimensions.period);
      if (def.kind === 'stock') return !p.start && p.end === mainEnd;
      return !!p.start && p.end === mainEnd && (day(p.end) - day(p.start)) / 86400000 >= 340;
    };
    const cand = num.filter(at);
    const find = (names: string[]) => cand.find((x) => names.some((n) => x.dimensions.concept === `ifrs-full:${n}`));
    const s = find(def.std);
    if (s) { cols[col] = 'std'; detail[col] = { concept: s.dimensions.concept, value: s.value, decimals: s.decimals, unit: s.dimensions.unit }; continue; }
    const a = find(def.alt);
    const e = cand.find((x) => !String(x.dimensions.concept).startsWith('ifrs-full:') && def.kw.test(String(x.dimensions.concept).split(':')[1]));
    if (e) { cols[col] = 'ext:' + String(e.dimensions.concept).split(':')[1]; detail[col] = { concept: e.dimensions.concept, value: e.value, unit: e.dimensions.unit }; if (a) cols[col] += `|alt:${a.dimensions.concept.split(':')[1]}`; continue; }
    if (a) { cols[col] = 'alt:' + a.dimensions.concept.split(':')[1]; detail[col] = { concept: a.dimensions.concept, value: a.value, unit: a.dimensions.unit }; continue; }
    cols[col] = '—';
  }
  out.push({ ...stats, cols, detail });
}
await writeFile('fixtures/esef/q23.json', JSON.stringify(out, null, 1));
console.log('fxo\tMB\thechos\tsin_dim\tnum_sin_dim\tconceptos\tcierre\tunidades\ttaxonomía');
for (const o of out) console.log([o.fxo, (o.bytes / 1e6).toFixed(1), o.facts, o.nondim, o.numericNondim, o.concepts, o.mainEnd, o.units.join(','), o.taxonomy.replace(/https:\/\/xbrl.ifrs.org\/taxonomy\//g, '').replace(/\/ifrs-full/g, '')].join('\t'));
console.log('\nfxo\t' + Object.keys(COLS).join('\t'));
for (const o of out) console.log([o.fxo.slice(0, 20) + o.fxo.slice(20, 30), ...Object.keys(COLS).map((c) => o.cols[c])].join('\t'));
console.log('\nnoString:', out.reduce((a, o) => a + o.nonString, 0), 'sin decimals:', out.reduce((a, o) => a + o.noDecimals, 0));
