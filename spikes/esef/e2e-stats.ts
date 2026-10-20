// Prueba de punta a punta de la fase 1 de P19: cifras de lo capturado y extraído en la base de desarrollo (solo lectura).
import { closePool, pool } from '../../src/db/pool.js';
import { chosenFilings } from '../../src/esef/choose.js';

const q = async <T extends object>(sql: string, p: unknown[] = []) => (await pool.query<T>(sql, p)).rows;
const show = (title: string, rows: unknown) => console.log(`\n## ${title}\n${JSON.stringify(rows, null, 1)}`);

try {
  show('corridas de ESEF', await q("SELECT ingestion_run_id AS id, scope, status, req_count, ok_count, error_count, to_char(started_at, 'HH24:MI:SS') AS inicio, to_char(finished_at, 'HH24:MI:SS') AS fin FROM ingestion_run WHERE provider = 'esef' ORDER BY 1"));
  show('raw_payload por endpoint, estado HTTP y parse_status', await q("SELECT rp.endpoint, rp.http_status, rp.parse_status, count(*)::int AS n FROM raw_payload rp JOIN ingestion_run r USING (ingestion_run_id) WHERE r.provider = 'esef' GROUP BY 1,2,3 ORDER BY 1,2,3"));
  show('errores de extracción', await q("SELECT params->>'fxo_id' AS fxo_id, parse_error FROM raw_payload rp JOIN ingestion_run r USING (ingestion_run_id) WHERE r.provider = 'esef' AND rp.parse_status = 'error'"));
  show('almacenamiento del crudo de ESEF (blobs distintos)', await q(
    `SELECT b.endpoint, count(*)::int AS blobs, sum(b.size_bytes)::bigint AS bruto_bytes, sum(octet_length(b.body))::bigint AS guardado_bytes, sum(pg_column_size(b.body))::bigint AS pg_column_size_bytes,
            round(100.0 * sum(octet_length(b.body)) / sum(b.size_bytes), 2) AS pct_guardado
     FROM (SELECT DISTINCT ON (pb.content_hash) rp.endpoint, pb.* FROM raw_payload rp JOIN ingestion_run r USING (ingestion_run_id) JOIN payload_blob pb USING (content_hash) WHERE r.provider = 'esef' ORDER BY pb.content_hash) b
     GROUP BY 1 ORDER BY 1`));
  show('formatos de body en payload_blob', await q('SELECT body_format, count(*)::int AS n FROM payload_blob GROUP BY 1 ORDER BY 1'));
  show('hash de los blobs de ESEF verificado al leerlos: ver extractor (parse_status ok = hash coincide)', {});
  show('esef_filing / esef_fact', (await q(`SELECT (SELECT count(*)::int FROM esef_filing) AS filings, (SELECT count(DISTINCT lei)::int FROM esef_filing) AS leis, (SELECT count(*)::int FROM esef_fact) AS facts,
     (SELECT count(*) FILTER (WHERE is_extension)::int FROM esef_fact) AS facts_extension, (SELECT count(DISTINCT concept)::int FROM esef_fact) AS conceptos,
     (SELECT count(*)::int FROM esef_fact WHERE decimals IS NULL) AS sin_decimals, (SELECT count(*)::int FROM esef_fact WHERE period_start IS NULL) AS instantes`))[0]);
  show('hechos por informe (mín / media / máx)', (await q('SELECT min(n)::int AS min, round(avg(n))::int AS media, max(n)::int AS max FROM (SELECT count(*) AS n FROM esef_fact GROUP BY esef_filing_id) t'))[0]);
  show('informes anuales por empresa (LEI) y número de cierres distintos', await q('SELECT lei, count(*)::int AS presentaciones, count(DISTINCT period_end)::int AS cierres, min(period_end)::text AS primero, max(period_end)::text AS ultimo FROM esef_filing GROUP BY 1 ORDER BY 1'));
  const chosen = await chosenFilings(pool);
  show('presentaciones: total, cierres (LEI, cierre) y elegidas', { presentaciones: (await q('SELECT count(*)::int AS n FROM esef_filing'))[0], elegidas: chosen.length });
  show('cierres con más de una presentación', await q("SELECT lei, period_end::text, string_agg(substring(fxo_id from 22), ', ' ORDER BY fxo_id) AS presentaciones FROM esef_filing GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 1,2 LIMIT 12"));
  show('cierre real distinto del del índice', await q("SELECT fxo_id, index_period_end::text, period_end::text FROM esef_filing WHERE index_period_end IS DISTINCT FROM period_end ORDER BY fxo_id"));
  show('payloads sin esef_filing (descartados como no anuales), por empresa', await q(
    `SELECT rp.provider_symbol AS lei, count(*)::int AS n FROM raw_payload rp JOIN ingestion_run r USING (ingestion_run_id)
     WHERE r.provider = 'esef' AND rp.endpoint = 'filing-json' AND rp.http_status = 200 AND NOT EXISTS (SELECT 1 FROM esef_filing f WHERE f.fxo_id = rp.params->>'fxo_id') GROUP BY 1 ORDER BY 1`));
  show('tamaño en disco de las tablas', await q("SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total FROM pg_class WHERE relname IN ('esef_filing', 'esef_fact', 'payload_blob', 'raw_payload') ORDER BY 1"));
} finally {
  await closePool();
}
