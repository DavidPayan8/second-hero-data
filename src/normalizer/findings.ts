import type pg from 'pg';

export type FindingOutcome = 'inserted' | 'updated' | 'suppressed' | 'disabled';

export interface FindingInput {
  ruleCode: string;
  targetTable: string;
  targetKey: Record<string, unknown>;
  // Determinista sobre los datos: los valores evaluados, nunca la fecha del pase ni contadores que crecen solos.
  detail: Record<string, unknown> | null;
  detectedByRun?: string | null;
  // Para findings con detail { old, new } (CORPORATE_EVENT_CHANGED, PRICE_REVISED): si ya hay uno abierto, se conserva su `old`
  // (el valor anterior a la primera corrección) y solo se actualiza `new`.
  keepFirstOld?: boolean;
}

// Emite un finding siguiendo las reglas de decisiones-modelo-validacion.md §6:
//  - regla apagada (validation_rule.enabled = false): no se emite;
//  - ya hay uno ABIERTO para la misma regla y objetivo: se actualiza su detail, detected_at conserva la primera detección;
//  - hay uno CERRADO con la misma regla, objetivo y detail idéntico: no se re-emite (aceptarlo tiene que durar);
//  - si no, se inserta uno nuevo con la severidad por defecto de la regla.
// Debe llamarse dentro de la transacción del escritor.
export async function emitFinding(c: pg.PoolClient, f: FindingInput): Promise<FindingOutcome> {
  const rule = (await c.query<{ enabled: boolean; default_severity: string }>('SELECT enabled, default_severity FROM validation_rule WHERE rule_code = $1', [f.ruleCode])).rows[0];
  if (!rule) throw new Error(`Regla de validación no catalogada: ${f.ruleCode}`);
  if (!rule.enabled) return 'disabled';
  const key = JSON.stringify(f.targetKey);
  let detailObj = f.detail;
  if (f.keepFirstOld && detailObj) {
    const open = await c.query<{ detail: { old?: unknown } | null }>(
      "SELECT detail FROM data_quality_finding WHERE rule_code = $1 AND target_table = $2 AND target_key = $3::jsonb AND status = 'open'", [f.ruleCode, f.targetTable, key]);
    const first = open.rows[0]?.detail;
    if (first && first.old !== undefined) detailObj = { ...detailObj, old: first.old };
  }
  const detail = detailObj === null ? null : JSON.stringify(detailObj);

  const closed = await c.query(
    `SELECT 1 FROM data_quality_finding
     WHERE rule_code = $1 AND target_table = $2 AND target_key = $3::jsonb AND status <> 'open' AND detail IS NOT DISTINCT FROM $4::jsonb LIMIT 1`,
    [f.ruleCode, f.targetTable, key, detail],
  );
  if (closed.rowCount) return 'suppressed';

  const r = await c.query<{ inserted: boolean }>(
    `INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detail, detected_by_run)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (rule_code, target_table, target_key) WHERE status = 'open' DO UPDATE SET detail = EXCLUDED.detail
     RETURNING (xmax = 0) AS inserted`,
    [f.ruleCode, rule.default_severity, f.targetTable, key, detail, f.detectedByRun ?? null],
  );
  return r.rows[0]!.inserted ? 'inserted' : 'updated';
}
