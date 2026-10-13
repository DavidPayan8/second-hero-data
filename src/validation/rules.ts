import { BASE_CURRENCY } from '../fx/subunits.js';
import { VALIDATION_CONFIG as CFG } from './config.js';
import { emitCandidates, type EmitCounts } from './emit.js';
import type { RuleContext } from './runner.js';

// Reglas de calidad de dato que se evalúan con SQL sobre la fuente de verdad (PLAN.md Fase 4). Cada una devuelve las filas
// candidatas (target_table, target_key, detail); emitCandidates aplica las reglas de emisión. Las reglas que emite el normalizador
// (IDENTITY_*, SECTOR_UNMAPPED, VENUE_UNMAPPED...) no están aquí. ACCOUNTING_BALANCE sigue apagada (D4) y no tiene lógica.

// CURRENCY_COHERENCE: la divisa de FUNDAMENTALS y la quote_currency del listing primario tienen camino de conversión en FX_RATES.
// Una divisa tiene camino si es la base (factor 1) o tiene alguna fila de tipo de cambio (GBX es fila propia). Solo cuentan las
// divisas de reporte distintas de la de cotización: si coinciden no hay nada que convertir. Objetivo: el listing.
export async function currencyCoherence(ctx: RuleContext): Promise<EmitCounts> {
  return emitCandidates(ctx.c, 'CURRENCY_COHERENCE', ctx.severity,
    `WITH pairs AS (
       SELECT l.listing_id, l.quote_currency, array_agg(DISTINCT f.currency ORDER BY f.currency) AS reporting
       FROM listing l JOIN security s USING (security_id) JOIN fundamentals f ON f.company_id = s.company_id
       WHERE l.is_primary_listing AND l.status = 'active' GROUP BY l.listing_id, l.quote_currency),
     need AS (
       SELECT p.*, array_remove(p.reporting, p.quote_currency) AS differing FROM pairs p),
     missing AS (
       SELECT n.listing_id, n.quote_currency, n.reporting,
              ARRAY(SELECT DISTINCT cur FROM unnest(n.differing || n.quote_currency) cur
                    WHERE cur <> $3 AND NOT EXISTS (SELECT 1 FROM fx_rates x WHERE x.currency = cur) ORDER BY cur) AS absent
       FROM need n WHERE cardinality(n.differing) > 0)
     SELECT 'listing'::text AS target_table, jsonb_build_object('listing_id', listing_id) AS target_key,
            jsonb_build_object('quote_currency', quote_currency, 'reporting_currencies', to_jsonb(reporting), 'without_fx_rates', to_jsonb(absent)) AS detail
     FROM missing WHERE cardinality(absent) > 0`, [BASE_CURRENCY]);
}

// YOY_JUMP: ingresos o acciones en circulación con una variación de más del yoyJumpRatio frente al mismo periodo del año anterior
// (versión más reciente de cada periodo; misma divisa; periodo anterior = el más cercano a un año antes dentro de la ventana).
// Objetivo: la fila del periodo actual. Un anterior en 0 no se compara.
export async function yoyJump(ctx: RuleContext): Promise<EmitCounts> {
  const revenue = await emitCandidates(ctx.c, 'YOY_JUMP', ctx.severity,
    `WITH latest AS (
       SELECT DISTINCT ON (company_id, period_end, period_type) fundamentals_id, company_id, period_end, period_type, currency, revenue
       FROM fundamentals ORDER BY company_id, period_end, period_type, reported_at DESC)
     SELECT 'fundamentals'::text AS target_table, jsonb_build_object('fundamentals_id', cur.fundamentals_id) AS target_key,
            jsonb_build_object('metric', 'revenue', 'period_end', cur.period_end, 'current', cur.revenue, 'prior_period_end', prev.period_end, 'prior', prev.revenue) AS detail
     FROM latest cur
     JOIN LATERAL (
       SELECT p.* FROM latest p
       WHERE p.company_id = cur.company_id AND p.period_type = cur.period_type AND p.currency = cur.currency
         AND p.period_end BETWEEN (cur.period_end - interval '1 year')::date - $4::int AND (cur.period_end - interval '1 year')::date + $4::int
       ORDER BY abs(p.period_end - (cur.period_end - interval '1 year')::date), p.period_end LIMIT 1) prev ON true
     WHERE cur.revenue IS NOT NULL AND prev.revenue IS NOT NULL AND prev.revenue <> 0 AND abs(cur.revenue - prev.revenue) / abs(prev.revenue) > $3::numeric`,
    [CFG.yoyJumpRatio, CFG.yoyPeriodWindowDays]);
  const shares = await emitCandidates(ctx.c, 'YOY_JUMP', ctx.severity,
    `WITH latest AS (
       SELECT DISTINCT ON (security_id, period_end) shares_outstanding_id, security_id, period_end, shares
       FROM shares_outstanding ORDER BY security_id, period_end, reported_at DESC)
     SELECT 'shares_outstanding'::text AS target_table, jsonb_build_object('shares_outstanding_id', cur.shares_outstanding_id) AS target_key,
            jsonb_build_object('metric', 'shares', 'period_end', cur.period_end, 'current', cur.shares, 'prior_period_end', prev.period_end, 'prior', prev.shares) AS detail
     FROM latest cur
     JOIN LATERAL (
       SELECT p.* FROM latest p
       WHERE p.security_id = cur.security_id
         AND p.period_end BETWEEN (cur.period_end - interval '1 year')::date - $4::int AND (cur.period_end - interval '1 year')::date + $4::int
       ORDER BY abs(p.period_end - (cur.period_end - interval '1 year')::date), p.period_end LIMIT 1) prev ON true
     WHERE prev.shares <> 0 AND abs(cur.shares - prev.shares) / abs(prev.shares) > $3::numeric`,
    [CFG.yoyJumpRatio, CFG.yoyPeriodWindowDays]);
  return sum(revenue, shares);
}

// STALENESS: los últimos fundamentales (max reported_at) o el último precio del listing primario activo superan el umbral. Objetivo:
// la security. El detail es la última fecha disponible (nunca los días de retraso, que cambian solos cada día). Sin ningún
// fundamental o ningún precio no hay "último": no se evalúa.
export async function staleness(ctx: RuleContext): Promise<EmitCounts> {
  return emitCandidates(ctx.c, 'STALENESS', ctx.severity,
    `WITH last AS (
       SELECT s.security_id,
              (SELECT max(f.reported_at) FROM fundamentals f WHERE f.company_id = s.company_id) AS last_fundamentals,
              (SELECT max(p.date) FROM prices_daily p WHERE p.listing_id = l.listing_id) AS last_price
       FROM security s JOIN listing l ON l.security_id = s.security_id AND l.is_primary_listing AND l.status = 'active'),
     stale AS (
       SELECT security_id,
              CASE WHEN last_fundamentals IS NOT NULL AND $3::date - last_fundamentals > $4::int THEN last_fundamentals END AS fundamentals,
              CASE WHEN last_price IS NOT NULL AND last_price < $3::date
                        AND (SELECT count(*) FROM generate_series(last_price + 1, $3::date, interval '1 day') d WHERE extract(isodow FROM d) < 6) > $5::int
                   THEN last_price END AS price
       FROM last)
     SELECT 'security'::text AS target_table, jsonb_build_object('security_id', security_id) AS target_key,
            jsonb_strip_nulls(jsonb_build_object('last_fundamentals', fundamentals, 'last_price', price)) AS detail
     FROM stale WHERE fundamentals IS NOT NULL OR price IS NOT NULL`,
    [ctx.today, CFG.stalenessFundamentalsDays, CFG.stalenessPriceBusinessDays]);
}

function sum(a: EmitCounts, b: EmitCounts): EmitCounts {
  return { candidates: a.candidates + b.candidates, inserted: a.inserted + b.inserted, updated: a.updated + b.updated, unchanged: a.unchanged + b.unchanged, suppressed: a.suppressed + b.suppressed };
}
