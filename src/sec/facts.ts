// Lectura de companyfacts de la SEC. FORMA SIN VERIFICAR CON UN PAYLOAD REAL: viene de la documentación pública de la API XBRL
// (https://www.sec.gov/search-filings/edgar-application-programming-interfaces); no hay una captura de data.sec.gov en este
// repo (falta un SEC_USER_AGENT real). Forma esperada:
//   { cik, entityName, facts: { "us-gaap": { "<Tag>": { units: { "USD": [ { start?, end, val, accn, fy, fp, form, filed, frame? } ] } } } } }
// `start` solo en magnitudes de periodo (ingresos, beneficio); las de fecha (activo) llevan solo `end`. Todo lo que no encaje con
// esa forma se trata como ausente, nunca se adivina.

// ----------------------------------------------------------------------------------------------------------------------
// PROVISIONAL: etiquetas us-gaap de cada magnitud, en orden de preferencia (se usa la primera que tenga un dato del periodo).
// ÚNICO sitio con esta lista. A confirmar con payloads reales: p. ej. los ingresos de una empresa cambian de etiqueta con el tiempo
// (SalesRevenueNet -> RevenueFromContractWithCustomerExcludingAssessedTax tras ASC 606).
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

export interface SecFact { metric: SecMetric; tag: string; value: string; end: string; form: string; filed: string; accn: string | null }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

// El dato de una magnitud para un cierre y un tipo de periodo: entradas en USD con ese `end`, el formulario del tipo y, en las de
// periodo, la duración esperada; si hay varias (la misma cifra repetida en formularios posteriores o reexpresada), la presentada
// más tarde. Devuelve null si no hay.
export function findFact(body: unknown, metric: SecMetric, periodEnd: string, periodType: 'A' | 'Q'): SecFact | null {
  const gaap = isObj(body) && isObj(body.facts) && isObj(body.facts['us-gaap']) ? body.facts['us-gaap'] : null;
  if (!gaap) return null;
  for (const tag of SEC_TAGS[metric]) {
    const node = gaap[tag];
    const usd = isObj(node) && isObj(node.units) && Array.isArray(node.units.USD) ? node.units.USD : [];
    let best: SecFact | null = null;
    for (const e of usd) {
      if (!isObj(e) || e.end !== periodEnd || e.form !== FORM[periodType] || (typeof e.val !== 'number' && typeof e.val !== 'string')) continue;
      if (DURATION[metric]) {
        if (typeof e.start !== 'string') continue;
        const d = days(e.start, periodEnd);
        if (d < DURATION_DAYS[periodType][0] || d > DURATION_DAYS[periodType][1]) continue;
      }
      const filed = typeof e.filed === 'string' ? e.filed : '';
      if (!best || filed > best.filed) best = { metric, tag, value: String(e.val), end: periodEnd, form: String(e.form), filed, accn: typeof e.accn === 'string' ? e.accn : null };
    }
    if (best) return best;
  }
  return null;
}

// |proveedor - SEC| <= tolerancia * |SEC|. Con SEC = 0 solo vale el 0 exacto.
export function withinTolerance(provider: string, sec: string, tolerance: number): boolean {
  const a = Number(provider), b = Number(sec);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return b === 0 ? a === 0 : Math.abs(a - b) <= tolerance * Math.abs(b);
}
