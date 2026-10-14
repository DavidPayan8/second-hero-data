// Lectura de companyfacts de la SEC. Forma verificada el 2026-10-14 con capturas reales de AAPL, AMZN y TSLA (coincide con la de
// la documentación pública: https://www.sec.gov/search-filings/edgar-application-programming-interfaces; claves de primer nivel
// cik, entityName y facts; taxonomías dei y us-gaap, y a veces ecd y ffd). Forma:
//   { cik, entityName, facts: { "us-gaap": { "<Tag>": { units: { "USD": [ { start?, end, val, accn, fy, fp, form, filed, frame? } ] } } } } }
// `start` solo en magnitudes de periodo (ingresos, beneficio); las de fecha (activo) llevan solo `end`. Todo lo que no encaje con
// esa forma se trata como ausente, nunca se adivina.

// ----------------------------------------------------------------------------------------------------------------------
// Etiquetas us-gaap de cada magnitud, en orden de preferencia. ÚNICO sitio con esta lista. Contrastadas el 2026-10-14 con los
// companyfacts reales de AAPL, AMZN y TSLA:
//  - ingresos: AAPL usa SalesRevenueNet hasta 2018 y RevenueFromContractWithCustomerExcludingAssessedTax después (Revenues solo 2016-2018);
//    AMZN, igual (SalesRevenueNet hasta 2018); TSLA usa Revenues (todo el histórico) y la de ASC 606 desde 2018.
//  - beneficio: NetIncomeLoss (atribuible a la matriz) en las tres; TSLA además ProfitLoss (consolidado, con participación no
//    controladora). El proveedor da a veces uno y a veces el otro: solo NetIncomeLoss cuenta para cross_checked; coincidir solo con
//    ProfitLoss es un SECOND_SOURCE_MISMATCH con kind 'consolidated'.
//  - activo: Assets en las tres.
// ----------------------------------------------------------------------------------------------------------------------
export const SEC_TAGS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  net_income: ['NetIncomeLoss', 'ProfitLoss'],
  total_assets: ['Assets'],
} as const;
export type SecMetric = keyof typeof SEC_TAGS;
export const SEC_METRICS = Object.keys(SEC_TAGS) as SecMetric[];

// Magnitudes de periodo (llevan duración) frente a las de fecha.
const DURATION: Record<SecMetric, boolean> = { revenue: true, net_income: true, total_assets: false };

// Formulario y duración esperados de cada tipo de periodo (10-K anual, 10-Q trimestral).
const FORM = { A: '10-K', Q: '10-Q' } as const;
const DURATION_DAYS = { A: [350, 380], Q: [80, 100] } as const;

// `later`: las presentaciones posteriores del mismo cierre y etiqueta (la misma cifra repetida o reexpresada en informes siguientes), por `filed`.
export interface SecFact { metric: SecMetric; tag: string; value: string; end: string; form: string; filed: string; accn: string | null; later: SecFact[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

// Los datos de una magnitud para un cierre y un tipo de periodo, uno por etiqueta (en orden de preferencia): entradas en USD con
// ese `end` (o a menos de windowDays de él: EODHD da el fin de mes y la SEC el cierre real de los ejercicios de 52/53 semanas), el
// formulario del tipo y, en las de periodo, la duración esperada. Si una etiqueta tiene varias (la misma cifra repetida o reexpresada en
// informes posteriores), el cierre más cercano y, a igualdad, la presentación cuyo `filed` esté más cerca de `reportedAt` (la fecha de
// la fila: es la presentación original, no la reexpresada; decisiones-modelo-validacion.md 7). Sin `reportedAt`, la presentada más tarde.
export function findFacts(body: unknown, metric: SecMetric, periodEnd: string, periodType: 'A' | 'Q', windowDays = 0, reportedAt?: string): SecFact[] {
  const gaap = isObj(body) && isObj(body.facts) && isObj(body.facts['us-gaap']) ? body.facts['us-gaap'] : null;
  if (!gaap) return [];
  const out: SecFact[] = [];
  for (const tag of SEC_TAGS[metric]) {
    const node = gaap[tag];
    const usd = isObj(node) && isObj(node.units) && Array.isArray(node.units.USD) ? node.units.USD : [];
    const found: { fact: SecFact; gap: number }[] = [];
    for (const e of usd) {
      if (!isObj(e) || typeof e.end !== 'string' || e.form !== FORM[periodType] || (typeof e.val !== 'number' && typeof e.val !== 'string')) continue;
      const gap = Math.abs(days(e.end, periodEnd));
      if (!(gap <= windowDays)) continue;
      if (DURATION[metric]) {
        if (typeof e.start !== 'string') continue;
        const d = days(e.start, e.end);
        if (d < DURATION_DAYS[periodType][0] || d > DURATION_DAYS[periodType][1]) continue;
      }
      found.push({ gap, fact: { metric, tag, value: String(e.val), end: e.end, form: String(e.form), filed: typeof e.filed === 'string' ? e.filed : '', accn: typeof e.accn === 'string' ? e.accn : null, later: [] } });
    }
    if (!found.length) continue;
    const minGap = Math.min(...found.map((x) => x.gap));
    const sameEnd = found.filter((x) => x.gap === minGap).map((x) => x.fact);
    // La original: el `filed` más cercano a reportedAt (sin reportedAt, la presentada más tarde); empate, la más antigua.
    const distance = (x: SecFact) => (reportedAt && x.filed ? Math.abs(days(x.filed, reportedAt)) : 0);
    const best = sameEnd.reduce((p, x) => {
      if (reportedAt) return distance(x) < distance(p) || (distance(x) === distance(p) && x.filed < p.filed) ? x : p;
      return x.filed > p.filed ? x : p;
    });
    best.later = sameEnd.filter((x) => x !== best && x.filed > best.filed).sort((p, q) => p.filed.localeCompare(q.filed));
    if (best) out.push(best);
  }
  return out;
}

// Para ingresos de un tag preferido y respaldo: el primero con dato. Atajo de findFacts.
export const findFact = (body: unknown, metric: SecMetric, periodEnd: string, periodType: 'A' | 'Q', windowDays = 0, reportedAt?: string): SecFact | null =>
  findFacts(body, metric, periodEnd, periodType, windowDays, reportedAt)[0] ?? null;

// El beneficio neto que cuenta es el atribuible a la matriz (alimenta el BPA); el consolidado (ProfitLoss) solo sirve para decir que
// el proveedor trae esa otra definición (decisiones-modelo-validacion.md 7).
export const ATTRIBUTABLE_NET_INCOME_TAG = 'NetIncomeLoss';

// |proveedor - SEC| <= tolerancia * |SEC|. Con SEC = 0 solo vale el 0 exacto.
export function withinTolerance(provider: string, sec: string, tolerance: number): boolean {
  const a = Number(provider), b = Number(sec);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return b === 0 ? a === 0 : Math.abs(a - b) <= tolerance * Math.abs(b);
}

// ¿El cierre de una fila trimestral es el cierre del ejercicio? El cuarto trimestre no tiene 10-Q propio: se sabe porque la SEC
// tiene un 10-K con ingresos o beneficio de un año que acaba ese día (decisiones-modelo-validacion.md 7).
export const isFiscalYearEnd = (body: unknown, periodEnd: string, windowDays = 0): boolean =>
  findFacts(body, 'revenue', periodEnd, 'A', windowDays).length > 0 || findFacts(body, 'net_income', periodEnd, 'A', windowDays).length > 0;
