import { SEC_ENDPOINT, SEC_PROVIDER, cik10 } from '../sec/client.js';
import { SEC_METRICS, findFact, withinTolerance, type SecMetric } from '../sec/facts.js';
import { VALIDATION_CONFIG as CFG } from './config.js';
import { emitCandidates, type EmitCounts } from './emit.js';
import type { RuleContext } from './runner.js';

// SECOND_SOURCE_MISMATCH: cruza ingresos, beneficio neto y activo total de FUNDAMENTALS con los companyfacts de la SEC (empresas
// con CIK, cifras en USD), por fecha de cierre y formulario (10-K anual, 10-Q trimestral). No llama a ninguna red: lee el último
// payload capturado de cada CIK (provider 'sec', `npm run sec-capture`).
//  - Todas las magnitudes con dato en las dos fuentes dentro de la tolerancia (y al menos una): la fila pasa de 'provider' a
//    'cross_checked' y se sella cross_checked_at (solo en esa transición; la inmutabilidad de FUNDAMENTALS es de los valores, no de
//    este flag de procedencia, decisiones-modelo-validacion.md 4).
//  - Alguna fuera de tolerancia: finding SECOND_SOURCE_MISMATCH y no se toca reported_at_source. Una magnitud sin dato en la SEC
//    se ignora; si ninguna se puede comparar la fila queda como está.
// Se evalúa la versión más reciente de cada periodo y solo filas con fuente 'provider' o 'cross_checked'.
export interface SecCounts extends EmitCounts { rows: number; compared: number; crossChecked: number; mismatched: number; noPayload: number; noFacts: number }

interface Row { fundamentals_id: string; cik: string; period_end: string; period_type: 'A' | 'Q'; source: string; revenue: string | null; net_income: string | null; total_assets: string | null }

export async function secSecondSource(ctx: RuleContext): Promise<SecCounts> {
  const rows = (await ctx.c.query<Row>(
    `SELECT f.fundamentals_id::text, c.cik, f.period_end::text, f.period_type, f.reported_at_source AS source, f.revenue::text, f.net_income::text, f.total_assets::text
     FROM fundamentals f JOIN company c ON c.company_id = f.company_id
     WHERE c.cik IS NOT NULL AND f.currency = 'USD' AND f.reported_at_source IN ('provider', 'cross_checked')
       AND f.reported_at = (SELECT max(g.reported_at) FROM fundamentals g WHERE g.company_id = f.company_id AND g.period_end = f.period_end AND g.period_type = f.period_type)
     ORDER BY c.cik, f.period_end, f.period_type`)).rows;
  const out: SecCounts = { candidates: 0, inserted: 0, updated: 0, unchanged: 0, suppressed: 0, rows: rows.length, compared: 0, crossChecked: 0, mismatched: 0, noPayload: 0, noFacts: 0 };
  if (!rows.length) return out;

  // Último payload correcto de cada CIK que tiene filas, leído una sola vez.
  const bodies = new Map<string, unknown>();
  for (const cik of new Set(rows.map((r) => cik10(r.cik)))) {
    const p = (await ctx.c.query<{ body: Buffer | null }>(
      `SELECT b.body FROM raw_payload rp JOIN ingestion_run r ON r.ingestion_run_id = rp.ingestion_run_id JOIN payload_blob b ON b.content_hash = rp.content_hash
       WHERE r.provider = $1 AND rp.endpoint = $2 AND rp.provider_symbol = $3 AND rp.http_status = 200 AND b.body IS NOT NULL
       ORDER BY rp.fetched_at DESC, rp.raw_payload_id DESC LIMIT 1`, [SEC_PROVIDER, SEC_ENDPOINT, cik])).rows[0];
    if (p?.body) {
      try { bodies.set(cik, JSON.parse(new TextDecoder('utf-8').decode(p.body))); } catch { /* JSON inválido: se trata como sin payload */ }
    }
  }

  const ok: string[] = [];
  const bad: { fundamentals_id: string; detail: unknown }[] = [];
  for (const row of rows) {
    const body = bodies.get(cik10(row.cik));
    if (body === undefined) { out.noPayload++; continue; }
    const mismatches: unknown[] = [];
    let comparedMetrics = 0;
    for (const metric of SEC_METRICS) {
      const mine = row[metric as SecMetric];
      if (mine === null) continue;
      const fact = findFact(body, metric, row.period_end, row.period_type);
      if (!fact) continue;
      comparedMetrics++;
      if (!withinTolerance(mine, fact.value, CFG.secTolerance)) {
        mismatches.push({ metric, provider: mine, sec: fact.value, sec_tag: fact.tag, sec_form: fact.form, sec_filed: fact.filed, sec_accn: fact.accn });
      }
    }
    if (!comparedMetrics) { out.noFacts++; continue; }
    out.compared++;
    if (mismatches.length) { out.mismatched++; bad.push({ fundamentals_id: row.fundamentals_id, detail: { period_end: row.period_end, period_type: row.period_type, tolerance: CFG.secTolerance, mismatches } }); }
    else if (row.source === 'provider') ok.push(row.fundamentals_id);
  }

  if (ok.length) {
    const r = await ctx.c.query(
      "UPDATE fundamentals SET reported_at_source = 'cross_checked', cross_checked_at = now() WHERE fundamentals_id = ANY($1::bigint[]) AND reported_at_source = 'provider'", [ok]);
    out.crossChecked = r.rowCount ?? 0;
  }
  const e = bad.length
    ? await emitCandidates(ctx.c, 'SECOND_SOURCE_MISMATCH', ctx.severity,
        `SELECT 'fundamentals'::text AS target_table, jsonb_build_object('fundamentals_id', f.fundamentals_id) AS target_key, i.detail
         FROM jsonb_to_recordset($3::jsonb) AS i(fundamentals_id bigint, detail jsonb) JOIN fundamentals f USING (fundamentals_id)`, [JSON.stringify(bad)])
    : { candidates: 0, inserted: 0, updated: 0, unchanged: 0, suppressed: 0 };
  return { ...out, ...e };
}
