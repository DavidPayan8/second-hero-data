import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { decodeBody } from './codec.js';
import { ESEF_CONFIG, ESEF_FILING_ENDPOINT } from './config.js';

// Extractor de ESEF: del xBRL-JSON crudo (payload_blob) a esef_filing + esef_fact. Determinista, sin red, sin LLM y versionado
// (ESEF_CONFIG.extractorVersion): vaciar las dos tablas y volver a pasarlo da lo mismo. Reglas (docs/esef/propuesta.md §7.1, §8.2):
//  - Solo hechos NUMÉRICOS (llevan unit) y SIN dimensiones (ninguna clave aparte de concept, entity, period, unit, language),
//    de todos los periodos, también los comparativos. Los hechos nil (valor null) no se guardan.
//  - Cierre real de los hechos: el xBRL-JSON da el fin de un periodo y los instantes como las 00:00 del día SIGUIENTE al cierre;
//    se resta ese día. El period_end del índice no se usa.
//  - Solo informes de ~1 año: el periodo principal es el cierre más reciente de entre los periodos de 340 a 380 días. Si no hay
//    ninguno (un intermedio), no se crea esef_filing.
//  - Deduplicar por (LEI, cierre real) NO se hace aquí: se guardan todas las presentaciones (ver choose.ts).

const BASE_DIMENSIONS = new Set(['concept', 'entity', 'period', 'unit', 'language']);
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DAY_MS = 86_400_000;

export interface ExtractedFact {
  concept: string;
  isExtension: boolean;
  periodStart: string | null;
  periodEnd: string;
  value: string;
  decimals: number | null;
  unit: string;
}

export interface Extraction {
  periodStart: string;
  periodEnd: string;
  ifrsTaxonomy: string | null;
  facts: ExtractedFact[];
  stats: { total: number; withDimensions: number; nonNumeric: number; nil: number; badValue: number; decimalsInf: number };
}

export type ExtractOutcome = { ok: true; extraction: Extraction } | { ok: false; reason: 'not_xbrl_json' | 'no_annual_period' };

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayOf = (raw: string) => Date.parse(raw.slice(0, 10) + 'T00:00:00Z');
// Fin de periodo o instante: las 00:00 de un día son el cierre del día anterior (xBRL-JSON). Con otra hora, o sin hora, es el propio día.
const closeDay = (raw: string) => (/T00:00:00(\.0+)?Z?$/.test(raw) ? iso(dayOf(raw) - DAY_MS) : raw.slice(0, 10));

function parsePeriod(raw: string): { start: string | null; end: string; durationDays: number | null } {
  const [a, b] = raw.split('/');
  if (b === undefined) return { start: null, end: closeDay(a!), durationDays: null };
  return { start: a!.slice(0, 10), end: closeDay(b), durationDays: (dayOf(b) - dayOf(a!)) / DAY_MS };
}

export function extractReport(json: unknown): ExtractOutcome {
  const doc = json as { documentInfo?: { namespaces?: Record<string, string> }; facts?: Record<string, { value?: unknown; decimals?: unknown; dimensions?: Record<string, unknown> }> };
  if (!doc || typeof doc !== 'object' || !doc.facts || typeof doc.facts !== 'object') return { ok: false, reason: 'not_xbrl_json' };
  const stats: Extraction['stats'] = { total: 0, withDimensions: 0, nonNumeric: 0, nil: 0, badValue: 0, decimalsInf: 0 };
  const facts: ExtractedFact[] = [];
  const mainEnds = new Map<string, Map<string, number>>(); // cierre -> inicio -> nº de hechos (periodos de ~1 año)

  for (const fact of Object.values(doc.facts)) {
    stats.total++;
    const dims = fact.dimensions ?? {};
    if (Object.keys(dims).some((k) => !BASE_DIMENSIONS.has(k))) { stats.withDimensions++; continue; }
    if (typeof dims.unit !== 'string') { stats.nonNumeric++; continue; }
    if (fact.value === null || fact.value === undefined) { stats.nil++; continue; }
    if (typeof fact.value !== 'string' || !NUMERIC.test(fact.value)) { stats.badValue++; continue; }
    if (typeof dims.concept !== 'string' || typeof dims.period !== 'string') { stats.badValue++; continue; }
    const p = parsePeriod(dims.period);
    let decimals: number | null = null;
    if (typeof fact.decimals === 'number' && Number.isInteger(fact.decimals)) decimals = fact.decimals;
    else if (fact.decimals === 'INF') stats.decimalsInf++;
    facts.push({ concept: dims.concept, isExtension: !dims.concept.startsWith('ifrs-full:'), periodStart: p.start, periodEnd: p.end, value: fact.value, decimals, unit: dims.unit });
    if (p.start !== null && p.durationDays !== null && p.durationDays >= ESEF_CONFIG.annualMinDays && p.durationDays <= ESEF_CONFIG.annualMaxDays) {
      const starts = mainEnds.get(p.end) ?? new Map<string, number>();
      starts.set(p.start, (starts.get(p.start) ?? 0) + 1);
      mainEnds.set(p.end, starts);
    }
  }
  if (mainEnds.size === 0) return { ok: false, reason: 'no_annual_period' };
  const periodEnd = [...mainEnds.keys()].sort().at(-1)!;
  // El inicio más frecuente de los periodos anuales que cierran ese día (desempate: el más tardío, para que sea determinista).
  const periodStart = [...mainEnds.get(periodEnd)!.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]![0];
  const taxonomy = Object.values(doc.documentInfo?.namespaces ?? {}).find((u) => /xbrl\.ifrs\.org\/taxonomy\/.*ifrs-full$|ifrs\.org\/taxonomy\/.*ifrs-full$/.test(u));
  const version = taxonomy ? /taxonomy\/(\d{4}-\d{2}-\d{2})\//.exec(taxonomy)?.[1] ?? taxonomy : null;
  return { ok: true, extraction: { periodStart, periodEnd, ifrsTaxonomy: version, facts, stats } };
}

// --------------------------------------------------------------------------------------------------------- escritura en BD

// El índice da las fechas sin zona horaria ("2023-01-18 11:02:47.966971"): se leen como UTC (no verificado).
const ts = (v: string | undefined) => (v ? v.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z') : null);
const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);

interface PayloadRow { id: string; params: Record<string, string>; content_hash: string; body: Buffer | null; body_format: string }

export interface ExtractSummary { checked: number; filings: number; facts: number; skippedNotAnnual: number; error: number }

async function writeExtraction(row: PayloadRow, x: Extraction): Promise<number> {
  const p = row.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const f = (await client.query<{ id: string }>(
      `INSERT INTO esef_filing (fxo_id, content_hash, index_sha256, lei, country, period_start, period_end, index_period_end, processed_at, date_added,
                                report_url, viewer_url, json_url, error_count, warning_count, inconsistency_count, ifrs_taxonomy, extractor_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (fxo_id) DO UPDATE SET content_hash = EXCLUDED.content_hash, index_sha256 = EXCLUDED.index_sha256, lei = EXCLUDED.lei, country = EXCLUDED.country,
         period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, index_period_end = EXCLUDED.index_period_end, processed_at = EXCLUDED.processed_at,
         date_added = EXCLUDED.date_added, report_url = EXCLUDED.report_url, viewer_url = EXCLUDED.viewer_url, json_url = EXCLUDED.json_url,
         error_count = EXCLUDED.error_count, warning_count = EXCLUDED.warning_count, inconsistency_count = EXCLUDED.inconsistency_count,
         ifrs_taxonomy = EXCLUDED.ifrs_taxonomy, extractor_version = EXCLUDED.extractor_version
       RETURNING esef_filing_id AS id`,
      [p.fxo_id, row.content_hash, p.sha256 ?? null, p.lei, p.country ?? null, x.periodStart, x.periodEnd, p.period_end ?? null, ts(p.processed), ts(p.date_added),
        p.report_url ?? null, p.viewer_url ?? null, p.json_url ?? null, num(p.error_count), num(p.warning_count), num(p.inconsistency_count), x.ifrsTaxonomy, ESEF_CONFIG.extractorVersion])).rows[0]!.id;
    await client.query('DELETE FROM esef_fact WHERE esef_filing_id = $1', [f]);
    // Por bloques: un informe grande son miles de hechos.
    for (let i = 0; i < x.facts.length; i += 2000) {
      const b = x.facts.slice(i, i + 2000);
      await client.query(
        `INSERT INTO esef_fact (esef_filing_id, concept, is_extension, period_start, period_end, value, decimals, unit, extractor_version)
         SELECT $1, * FROM unnest($2::text[], $3::boolean[], $4::date[], $5::date[], $6::numeric[], $7::integer[], $8::text[], $9::text[])`,
        [f, b.map((y) => y.concept), b.map((y) => y.isExtension), b.map((y) => y.periodStart), b.map((y) => y.periodEnd), b.map((y) => y.value), b.map((y) => y.decimals),
          b.map((y) => y.unit), b.map(() => ESEF_CONFIG.extractorVersion)]);
    }
    await client.query('COMMIT');
    return x.facts.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Quita lo que una extracción anterior dejó de esta presentación (hoy ya no es un informe anual: p. ej. cambió el extractor).
async function removeFiling(fxoId: string): Promise<void> {
  await pool.query('DELETE FROM esef_fact WHERE esef_filing_id IN (SELECT esef_filing_id FROM esef_filing WHERE fxo_id = $1)', [fxoId]);
  await pool.query('DELETE FROM esef_filing WHERE fxo_id = $1', [fxoId]);
}

// Extrae lo pendiente (parse_status 'pending') de las corridas de ESEF. Con `all` rehace el ÚLTIMO payload de cada presentación,
// también si ya estaba marcado (cambio de extractor, regeneración). Es idempotente.
export async function extractAll(options: { runId?: string; all?: boolean } = {}): Promise<ExtractSummary> {
  const rows = (await pool.query<{ id: string; fxo: string }>(
    `SELECT rp.raw_payload_id AS id, rp.params->>'fxo_id' AS fxo FROM raw_payload rp JOIN ingestion_run r USING (ingestion_run_id)
     WHERE r.provider = 'esef' AND rp.endpoint = $1 AND rp.http_status = 200 AND rp.content_hash IS NOT NULL AND ($2::bigint IS NULL OR rp.ingestion_run_id = $2::bigint)
       AND ${options.all
         ? `rp.raw_payload_id = (SELECT max(r2.raw_payload_id) FROM raw_payload r2 WHERE r2.endpoint = rp.endpoint AND r2.params->>'fxo_id' = rp.params->>'fxo_id' AND r2.http_status = 200)`
         : "rp.parse_status = 'pending'"}
     ORDER BY rp.raw_payload_id`, [ESEF_FILING_ENDPOINT, options.runId ?? null])).rows;
  const summary: ExtractSummary = { checked: 0, filings: 0, facts: 0, skippedNotAnnual: 0, error: 0 };
  const mark = (id: string, problem: string | null) => pool.query('UPDATE raw_payload SET parse_status = $2, parse_error = $3 WHERE raw_payload_id = $1', [id, problem ? 'error' : 'ok', problem]);
  for (const { id } of rows) {
    const row = (await pool.query<PayloadRow>(
      `SELECT rp.raw_payload_id AS id, rp.params, rp.content_hash, b.body, b.body_format FROM raw_payload rp JOIN payload_blob b USING (content_hash) WHERE rp.raw_payload_id = $1`, [id])).rows[0];
    summary.checked++;
    if (!row) { summary.error++; await mark(id, 'no hay payload_blob para esta llamada'); continue; }
    let problem: string | null = null;
    try {
      if (row.body === null) throw new Error('cuerpo purgado: no se puede releer');
      const bytes = decodeBody(row.body, row.body_format);
      if (createHash('sha256').update(bytes).digest('hex') !== row.content_hash) throw new Error('el hash del cuerpo guardado no coincide con content_hash');
      if (!/^[A-Z0-9]{20}$/.test(row.params.lei ?? '')) throw new Error(`el identificador de la entidad no es un LEI: ${row.params.lei}`);
      const out = extractReport(JSON.parse(bytes.toString('utf8')));
      if (!out.ok && out.reason === 'not_xbrl_json') throw new Error('el cuerpo no es un xBRL-JSON (sin facts)');
      if (!out.ok) { await removeFiling(row.params.fxo_id!); summary.skippedNotAnnual++; }
      else { summary.facts += await writeExtraction(row, out.extraction); summary.filings++; }
    } catch (e) {
      problem = (e as Error).message;
      summary.error++;
    }
    await mark(id, problem);
  }
  return summary;
}
