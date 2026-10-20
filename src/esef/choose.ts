import type pg from 'pg';

// Qué presentación vale para cada (LEI, cierre real) (docs/esef/propuesta.md §7.1). NO se guarda: se calcula siempre sobre TODAS las
// presentaciones capturadas (nunca dentro de un lote), de modo que capturar otra versión después cambia la elegida sin tocar nada más.
// Criterio: menos errores de validación (error_count), luego la procesada más recientemente, luego fxo_id (determinista).
// Nota del spike: las versiones (-0, -1…) de una misma presentación suelen ser idiomas distintos del mismo informe (p. ej. Volvo 2021:
// inglés y sueco) y los números coinciden; las de varios países son el mismo informe presentado en cada OAM.
export interface ChosenFiling { esef_filing_id: string; fxo_id: string; lei: string; period_end: string }

export async function chosenFilings(db: Pick<pg.Pool, 'query'>, filter: { leis?: string[] } = {}): Promise<ChosenFiling[]> {
  return (await db.query<ChosenFiling>(
    `SELECT DISTINCT ON (lei, period_end) esef_filing_id, fxo_id, lei, period_end::text AS period_end
     FROM esef_filing WHERE ($1::text[] IS NULL OR lei = ANY($1))
     ORDER BY lei, period_end, error_count ASC NULLS LAST, processed_at DESC NULLS LAST, fxo_id DESC`, [filter.leis ?? null])).rows;
}
