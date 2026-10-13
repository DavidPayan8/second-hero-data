import type pg from 'pg';

// Emisión de findings en lote desde una consulta de candidatos (decisiones-modelo-validacion.md 6). La consulta construye
// target_table, target_key (jsonb_build_object desde la propia fila, nunca a mano en TypeScript) y detail (determinista: solo
// valores de los datos, nunca la fecha del pase ni contadores). Reglas de emisión:
//  - ya hay un finding CERRADO con la misma regla, objetivo y detail idéntico: no se emite (aceptarlo tiene que durar);
//  - ya hay uno ABIERTO para la misma regla y objetivo: se actualiza su detail si cambió (detected_at conserva la primera detección);
//  - si no, se inserta uno nuevo con la severidad efectiva de la regla.
//  - cierre automático (decisiones-modelo-validacion.md 7): en una pasada COMPLETA (closeTables), cada finding abierto de la regla
//    en esas tablas cuyo objetivo ya no está entre los candidatos pasa a 'dismissed' con resolved_by 'runner'. Una pasada parcial no
//    pasa closeTables y no cierra nada. Un cierre del runner no suprime una reaparición (el estado volvió a cumplirse); uno humano sí.
// La consulta debe dar una sola fila por (target_table, target_key). $1 = rule_code y $2 = severidad quedan reservados: los
// parámetros de la consulta empiezan en $3.
export interface EmitCounts { candidates: number; inserted: number; updated: number; unchanged: number; suppressed: number; closed: number }
export const RUNNER_ACTOR = 'runner';

export async function emitCandidates(c: pg.PoolClient, ruleCode: string, severity: string, candidatesSql: string, params: unknown[] = [], closeTables?: string[]): Promise<EmitCounts> {
  const r = await c.query<{ candidates: number; fresh: number; inserted: number; updated: number }>(
    `WITH cand AS (${candidatesSql}),
          fresh AS (
            SELECT k.* FROM cand k WHERE NOT EXISTS (
              SELECT 1 FROM data_quality_finding f
              WHERE f.rule_code = $1 AND f.target_table = k.target_table AND f.target_key = k.target_key AND f.status <> 'open' AND f.resolved_by IS DISTINCT FROM '${RUNNER_ACTOR}' AND f.detail IS NOT DISTINCT FROM k.detail)),
          up AS (
            INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detail)
            SELECT $1, $2, target_table, target_key, detail FROM fresh
            ON CONFLICT (rule_code, target_table, target_key) WHERE status = 'open'
            DO UPDATE SET detail = EXCLUDED.detail WHERE data_quality_finding.detail IS DISTINCT FROM EXCLUDED.detail
            RETURNING (xmax = 0) AS inserted)
     SELECT (SELECT count(*) FROM cand)::int AS candidates, (SELECT count(*) FROM fresh)::int AS fresh,
            (SELECT count(*) FILTER (WHERE inserted) FROM up)::int AS inserted, (SELECT count(*) FILTER (WHERE NOT inserted) FROM up)::int AS updated`,
    [ruleCode, severity, ...params]);
  const x = r.rows[0]!;
  let closed = 0;
  if (closeTables?.length) {
    closed = (await c.query(
      `WITH cand AS (${candidatesSql})
       UPDATE data_quality_finding f SET status = 'dismissed', resolved_by = '${RUNNER_ACTOR}', resolved_at = now()
       WHERE f.rule_code = $1 AND f.status = 'open' AND f.target_table = ANY($2::text[])
         AND NOT EXISTS (SELECT 1 FROM cand k WHERE k.target_table = f.target_table AND k.target_key = f.target_key)`,
      [ruleCode, closeTables, ...params.slice(0)])).rowCount ?? 0;
  }
  return { candidates: x.candidates, inserted: x.inserted, updated: x.updated, unchanged: x.fresh - x.inserted - x.updated, suppressed: x.candidates - x.fresh, closed };
}
