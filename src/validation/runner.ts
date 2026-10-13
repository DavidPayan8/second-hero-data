import type pg from 'pg';
import { withActor } from '../db/withActor.js';
import type { EmitCounts } from './emit.js';
import { currencyCoherence, staleness, yoyJump } from './rules.js';
import { secSecondSource } from './secSecondSource.js';

// Runner de validación (PLAN.md Fase 4, decisiones-modelo-validacion.md). Lee VALIDATION_RULE: ejecuta solo las reglas con
// enabled = true que tienen lógica aquí (indexada por rule_code) y emite con su severidad efectiva (default_severity del catálogo).
// Corre DESPUÉS del normalizador, nunca rechaza ni borra: solo produce findings (y transiciona reported_at_source a cross_checked).
// Las reglas que emite el normalizador (IDENTITY_*, SECTOR_UNMAPPED, VENUE_UNMAPPED, ...) están catalogadas pero no tienen lógica
// en el runner. Cada regla va en su transacción: un fallo de una no revierte a las demás.
export interface RuleContext { c: pg.PoolClient; today: string; severity: string }
type RuleImpl = (ctx: RuleContext) => Promise<EmitCounts>;

export const RULE_IMPLS: Record<string, RuleImpl> = {
  CURRENCY_COHERENCE: currencyCoherence,
  YOY_JUMP: yoyJump,
  STALENESS: staleness,
  SECOND_SOURCE_MISMATCH: secSecondSource,
};

export interface ValidationSummary {
  today: string;
  ran: Record<string, EmitCounts & Record<string, number>>;
  failed: Record<string, string>;
  disabled: string[]; // reglas de este runner apagadas en VALIDATION_RULE
  withoutLogic: string[]; // reglas activas del catálogo sin lógica en el runner (las emite el normalizador)
}

export async function runValidation(options: { today?: string; only?: string[] } = {}): Promise<ValidationSummary> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const summary: ValidationSummary = { today, ran: {}, failed: {}, disabled: [], withoutLogic: [] };
  const catalog = await withActor('validator', 'lectura del catálogo', async (c) =>
    (await c.query<{ rule_code: string; default_severity: string; enabled: boolean }>('SELECT rule_code, default_severity, enabled FROM validation_rule ORDER BY rule_code')).rows);
  for (const rule of catalog) {
    const impl = RULE_IMPLS[rule.rule_code];
    if (!impl) { if (rule.enabled) summary.withoutLogic.push(rule.rule_code); continue; }
    if (!rule.enabled) { summary.disabled.push(rule.rule_code); continue; }
    if (options.only && !options.only.includes(rule.rule_code)) continue;
    try {
      summary.ran[rule.rule_code] = await withActor('validator', `validación ${rule.rule_code}`, (c) => impl({ c, today, severity: rule.default_severity })) as EmitCounts & Record<string, number>;
    } catch (e) {
      summary.failed[rule.rule_code] = (e as Error).message;
    }
  }
  return summary;
}
