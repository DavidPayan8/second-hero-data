import type pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const id = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
const HASH = 'a'.repeat(64);
const run = (c: pg.PoolClient) => id(c, "INSERT INTO ingestion_run (provider, scope) VALUES ('eodhd','eod:US') RETURNING ingestion_run_id AS id");
const blob = (c: pg.PoolClient, hash = HASH) => c.query("INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, '\\x7b7d', 2)", [hash]);

test('existen las 7 tablas del normalizador', async () => {
  const names = ['ingestion_run', 'payload_blob', 'raw_payload', 'source_exchange', 'source_venue_map', 'source_holder_map', 'source_sector_map'];
  const { rows } = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY 1", [names]);
  expect(rows.map((r) => r.table_name)).toEqual([...names].sort());
});

test('ingestion_run: status en dominio, contadores a 0 y finished_at solo cuando no corre', () => inRollback(async (c) => {
  const r = await run(c);
  expect((await c.query('SELECT status, finished_at, req_count, ok_count, error_count FROM ingestion_run WHERE ingestion_run_id=$1', [r])).rows[0])
    .toEqual({ status: 'running', finished_at: null, req_count: 0, ok_count: 0, error_count: 0 });
  expect((await dbError(c, "INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd','x','pausada', now())"))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd','x','ok', NULL)"))?.message).toContain('ingestion_run_finished_iff_not_running');
  expect((await dbError(c, "INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd','x','running', now())"))?.message).toContain('ingestion_run_finished_iff_not_running');
  for (const st of ['ok', 'partial', 'failed']) await c.query("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd','x',$1, now())", [st]);
  expect((await dbError(c, 'INSERT INTO ingestion_run (scope) VALUES ($1)', ['x']))?.code).toBe('23502');
  expect((await dbError(c, 'INSERT INTO ingestion_run (provider) VALUES ($1)', ['eodhd']))?.code).toBe('23502');
}));

test('payload_blob: PK = sha256 hex, body NULL si y solo si purgado', () => inRollback(async (c) => {
  await blob(c);
  expect((await dbError(c, "INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, '\\x7b7d', 2)", [HASH]))?.code).toBe('23505'); // dedup por hash
  for (const bad of ['ABC', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)]) {
    expect((await dbError(c, "INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, '\\x7b7d', 2)", [bad]))?.code, bad).toBe('23514');
  }
  // purgar = body NULL y purged_at a la vez
  await c.query('UPDATE payload_blob SET body = NULL, purged_at = now() WHERE content_hash = $1', [HASH]);
  expect((await dbError(c, 'UPDATE payload_blob SET purged_at = NULL WHERE content_hash = $1', [HASH]))?.message).toContain('payload_blob_body_iff_not_purged');
  expect((await dbError(c, "INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, NULL, 2)", ['b'.repeat(64)]))?.message).toContain('payload_blob_body_iff_not_purged');
  expect((await dbError(c, "INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, '\\x7b7d', 2)", ['c'.repeat(64)]))).toBeNull();
  expect((await dbError(c, "INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, '\\x7b7d', -1)", ['d'.repeat(64)]))?.code).toBe('23514');
  expect((await c.query("SELECT body_format FROM payload_blob WHERE content_hash=$1", [HASH])).rows[0].body_format).toBe('json');
}));

const RAW = "INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash) VALUES ($1,'eod',$2,$3,$4,$5)";

test('raw_payload: varias filas por blob, provider_symbol es texto sin FK, params jsonb', () => inRollback(async (c) => {
  const r = await run(c);
  await blob(c);
  await c.query(RAW, [r, 'AAPL.US', { period: 'd', order: 'a' }, 200, HASH]); // AAPL.US no existe en LISTING y no hace falta
  await c.query(RAW, [r, 'AAPL.US', { period: 'd', order: 'a' }, 200, HASH]); // dos llamadas, mismo cuerpo: dos filas, un blob
  await c.query(RAW, [r, null, {}, 200, HASH]); // llamada a nivel de bolsa
  const { rows } = await c.query("SELECT count(*)::int AS n, count(DISTINCT content_hash)::int AS blobs FROM raw_payload");
  expect(rows[0]).toEqual({ n: 3, blobs: 1 });
  expect((await c.query("SELECT params->>'period' AS p, parse_status, parse_error FROM raw_payload LIMIT 1")).rows[0]).toEqual({ p: 'd', parse_status: 'pending', parse_error: null });
  // sin FK a la fuente de verdad: ninguna restricción de raw_payload apunta a listing, security o company
  const fks = await pool.query("SELECT confrelid::regclass::text AS t FROM pg_constraint WHERE conrelid='raw_payload'::regclass AND contype='f' ORDER BY 1");
  expect(fks.rows.map((x) => x.t)).toEqual(['ingestion_run', 'payload_blob']);
}));

test('raw_payload con respuesta: obligatorios, FK, parse_status en dominio y parse_error si y solo si error', () => inRollback(async (c) => {
  const r = await run(c);
  await blob(c);
  expect((await dbError(c, RAW, [999999, 'X.US', {}, 200, HASH]))?.code).toBe('23503');
  expect((await dbError(c, RAW, [r, 'X.US', {}, 200, 'f'.repeat(64)]))?.code).toBe('23503'); // blob inexistente
  expect((await dbError(c, "INSERT INTO raw_payload (ingestion_run_id, http_status, content_hash) VALUES ($1,200,$2)", [r, HASH]))?.code).toBe('23502'); // sin endpoint
  expect((await dbError(c, "INSERT INTO raw_payload (ingestion_run_id, endpoint, http_status, content_hash, parse_status) VALUES ($1,'eod',200,$2,'roto')", [r, HASH]))?.code).toBe('23514');
  // con respuesta, http_status y content_hash son obligatorios
  expect((await dbError(c, RAW, [r, 'X.US', {}, null, HASH]))?.message).toContain('raw_payload_response_xor_transport_error');
  expect((await dbError(c, RAW, [r, 'X.US', {}, 200, null]))?.message).toContain('raw_payload_response_xor_transport_error');
  expect((await dbError(c, "INSERT INTO raw_payload (ingestion_run_id, endpoint, http_status, content_hash, parse_status) VALUES ($1,'eod',200,$2,NULL)", [r, HASH]))?.message).toContain('raw_payload_response_xor_transport_error');
  // parse_error NOT NULL si y solo si parse_status = 'error'
  const P = "INSERT INTO raw_payload (ingestion_run_id, endpoint, http_status, content_hash, parse_status, parse_error) VALUES ($1,'eod',200,$2,$3,$4)";
  expect((await dbError(c, P, [r, HASH, 'ok', 'x']))?.message).toContain('raw_payload_parse_error_iff_error');
  expect((await dbError(c, P, [r, HASH, 'pending', 'x']))?.message).toContain('raw_payload_parse_error_iff_error');
  expect((await dbError(c, P, [r, HASH, 'error', null]))?.message).toContain('raw_payload_parse_error_iff_error'); // el otro sentido
  await c.query(P, [r, HASH, 'error', 'campo inesperado']);
  await c.query(P, [r, HASH, 'ok', null]);
  expect((await dbError(c, 'DELETE FROM ingestion_run WHERE ingestion_run_id=$1', [r]))?.code).toBe('23503');
  expect((await dbError(c, 'DELETE FROM payload_blob WHERE content_hash=$1', [HASH]))?.code).toBe('23503');
}));

test('raw_payload: una respuesta 4xx/5xx SÍ es respuesta (cuerpo en payload_blob)', () => inRollback(async (c) => {
  const r = await run(c);
  await blob(c);
  for (const st of [403, 404, 429, 500, 503]) await c.query(RAW, [r, 'fundamentals/AAPL.US', {}, st, HASH]);
  await c.query("INSERT INTO raw_payload (ingestion_run_id, endpoint, http_status, content_hash, parse_status, parse_error) VALUES ($1,'fundamentals',403,$2,'error','Only EOD data allowed for free users')", [r, HASH]);
  expect((await c.query('SELECT count(*)::int AS n FROM raw_payload WHERE http_status >= 400')).rows[0].n).toBe(6);
}));

test('raw_payload sin respuesta (fallo de transporte): transport_error y los otros tres a NULL, todo a la vez', () => inRollback(async (c) => {
  const r = await run(c);
  await blob(c);
  const T = "INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, http_status, content_hash, parse_status, transport_error) VALUES ($1,'eod','AAPL.US',$2,$3,$4,$5)";
  await c.query(T, [r, null, null, null, 'ETIMEDOUT: connect timed out after 30000 ms']);
  const row = (await c.query('SELECT http_status, content_hash, parse_status, parse_error, transport_error FROM raw_payload')).rows[0];
  expect(row).toEqual({ http_status: null, content_hash: null, parse_status: null, parse_error: null, transport_error: 'ETIMEDOUT: connect timed out after 30000 ms' });
  // mezclar las dos formas falla, en cualquier combinación
  expect((await dbError(c, T, [r, 200, null, null, 'ECONNRESET']))?.message).toContain('raw_payload_response_xor_transport_error'); // http_status con transport_error
  expect((await dbError(c, T, [r, null, HASH, null, 'ECONNRESET']))?.message).toContain('raw_payload_response_xor_transport_error'); // content_hash con transport_error
  expect((await dbError(c, T, [r, null, null, 'pending', 'ECONNRESET']))?.message).toContain('raw_payload_response_xor_transport_error'); // parse_status con transport_error
  expect((await dbError(c, T, [r, 200, HASH, 'pending', 'ECONNRESET']))?.message).toContain('raw_payload_response_xor_transport_error'); // respuesta completa con transport_error
  expect((await dbError(c, T, [r, null, null, null, null]))?.message).toContain('raw_payload_response_xor_transport_error'); // ni respuesta ni error
  // un fallo de transporte no puede llevar parse_error (parse_status NULL)
  expect((await dbError(c, "INSERT INTO raw_payload (ingestion_run_id, endpoint, transport_error, parse_error) VALUES ($1,'eod','DNS','x')", [r]))).not.toBeNull();
  // si se omite parse_status en un fallo de transporte, el DEFAULT 'pending' lo rompe: el escritor lo pone a NULL explícitamente
  expect((await dbError(c, "INSERT INTO raw_payload (ingestion_run_id, endpoint, transport_error) VALUES ($1,'eod','DNS')", [r]))?.message).toContain('raw_payload_response_xor_transport_error');
  expect((await c.query('SELECT count(*)::int AS n FROM raw_payload')).rows[0].n).toBe(1);
}));

test('source_exchange: kind en dominio y default_mic solo en single, con FK a exchange.mic', () => inRollback(async (c) => {
  const S = "INSERT INTO source_exchange (provider, provider_code, kind, default_mic) VALUES ('otro',$1,$2,$3)";
  await c.query(S, ['A', 'single', 'XLON']);
  await c.query(S, ['B', 'aggregate', null]);
  await c.query(S, ['C', 'virtual', null]);
  expect((await dbError(c, S, ['A', 'single', 'XLON']))?.code).toBe('23505');
  expect((await dbError(c, S, ['D', 'single', null]))?.message).toContain('source_exchange_default_mic_iff_single');
  expect((await dbError(c, S, ['E', 'aggregate', 'XNAS']))?.message).toContain('source_exchange_default_mic_iff_single');
  expect((await dbError(c, S, ['F', 'virtual', 'XNAS']))?.message).toContain('source_exchange_default_mic_iff_single');
  expect((await dbError(c, S, ['G', 'mixto', null]))?.code).toBe('23514');
  expect((await dbError(c, S, ['H', 'single', 'ZZZZ']))?.code).toBe('23503'); // MIC sin curar en EXCHANGE: el normalizador no lo inventa
}));

test('source_venue_map: PK, FK al MIC y al código del proveedor', () => inRollback(async (c) => {
  const V = "INSERT INTO source_venue_map (provider, provider_code, provider_venue_label, mic) VALUES ($1,$2,$3,$4)";
  await c.query(V, ['eodhd', 'US', 'EtiquetaNueva', 'XNAS']);
  expect((await dbError(c, V, ['eodhd', 'US', 'EtiquetaNueva', 'XNYS']))?.code).toBe('23505');
  expect((await dbError(c, V, ['eodhd', 'US', 'Otra', 'ZZZZ']))?.code).toBe('23503'); // MIC inexistente
  expect((await dbError(c, V, ['eodhd', 'XX', 'Otra', 'XNAS']))?.code).toBe('23503'); // código sin source_exchange
  expect((await dbError(c, V, ['otro', 'US', 'Otra', 'XNAS']))?.code).toBe('23503'); // otro proveedor sin ese código
}));

test('seed SOURCE_EXCHANGE: US agregado, MC -> XMAD, virtuales, y todos los single apuntan a una bolsa curada', async () => {
  const { rows } = await pool.query<{ provider_code: string; kind: string; default_mic: string | null }>("SELECT provider_code, kind, default_mic FROM source_exchange WHERE provider='eodhd' ORDER BY 1");
  const byCode = Object.fromEntries(rows.map((r) => [r.provider_code, r]));
  expect(byCode.US).toEqual({ provider_code: 'US', kind: 'aggregate', default_mic: null });
  expect(byCode.MC).toEqual({ provider_code: 'MC', kind: 'single', default_mic: 'XMAD' });
  expect(byCode.LSE?.default_mic).toBe('XLON');
  expect(byCode.TO?.default_mic).toBe('XTSE');
  expect(byCode.XETRA?.default_mic).toBe('XETR');
  for (const v of ['FOREX', 'CC', 'MONEY', 'EUFUND', 'GBOND']) expect(byCode[v]?.kind, v).toBe('virtual');
  expect(rows.filter((r) => r.kind === 'single').length).toBe(18);
  // un código no curado (Frankfurt) no tiene fila: producirá VENUE_UNMAPPED
  expect(byCode.F).toBeUndefined();
  const orphan = await pool.query("SELECT 1 FROM source_exchange s LEFT JOIN exchange e ON e.mic = s.default_mic WHERE s.kind='single' AND e.mic IS NULL");
  expect(orphan.rows).toEqual([]);
});

test('seed SOURCE_VENUE_MAP: etiquetas de US a MIC según P9; sin fila OTCBB, US y NMFQS', async () => {
  const { rows } = await pool.query<{ provider_venue_label: string; mic: string }>("SELECT provider_venue_label, mic FROM source_venue_map WHERE provider='eodhd' AND provider_code='US' ORDER BY 1");
  const map = Object.fromEntries(rows.map((r) => [r.provider_venue_label, r.mic]));
  expect(map).toEqual({
    NASDAQ: 'XNAS', NYSE: 'XNYS', 'NYSE ARCA': 'ARCX', 'NYSE MKT': 'XASE', AMEX: 'XASE', BATS: 'BATS',
    OTC: 'OTCM', PINK: 'OTCM', OTCPK: 'OTCM', OTCQB: 'OTCM', OTCQX: 'OTCM', OTCMKTS: 'OTCM', OTCGREY: 'OTCM', OTCCE: 'OTCM',
  });
  for (const sinFila of ['OTCBB', 'US', 'NMFQS']) expect(map[sinFila], sinFila).toBeUndefined();
  expect(rows).toHaveLength(14);
});

test('seed SOURCE_VENUE_MAP: solo hay filas para códigos de kind aggregate', async () => {
  const { rows } = await pool.query("SELECT v.provider_code, e.kind FROM source_venue_map v JOIN source_exchange e USING (provider, provider_code) WHERE e.kind <> 'aggregate'");
  expect(rows).toEqual([]);
  const huerfanas = await pool.query("SELECT 1 FROM source_venue_map v LEFT JOIN source_exchange e USING (provider, provider_code) WHERE e.kind IS NULL");
  expect(huerfanas.rows).toEqual([]);
  expect((await pool.query("SELECT count(*)::int AS n FROM source_venue_map")).rows[0].n).toBeGreaterThan(0);
});

test('todo MIC del mapa de venues existe en EXCHANGE', async () => {
  const { rows } = await pool.query("SELECT v.mic FROM source_venue_map v LEFT JOIN exchange e ON e.mic = v.mic WHERE e.mic IS NULL");
  expect(rows).toEqual([]);
});

test('source_holder_map: el nombre guardado ya está normalizado con holder_name_norm()', () => inRollback(async (c) => {
  const M = "INSERT INTO source_holder_map (provider, holder_name_norm, holder_ref) VALUES ('eodhd',$1,$2)";
  await c.query(M, ['BLACKROCK INC', '0001364742']);
  expect((await dbError(c, M, ['BLACKROCK INC', 'otro']))?.code).toBe('23505');
  for (const bad of ['BlackRock Inc', 'BLACKROCK, INC.', ' BLACKROCK INC', 'BLACK  ROCK']) {
    expect((await dbError(c, M, [bad, '1']))?.message, bad).toContain('source_holder_map_name_is_normalized');
  }
  expect((await dbError(c, M, ['VANGUARD GROUP INC', null]))?.code).toBe('23502');
  // la misma función define la clave de holder_position: lo que normaliza una, lo normaliza la otra
  const n = (await c.query("SELECT holder_name_norm('BlackRock, Inc.') AS n")).rows[0].n;
  expect(n).toBe('BLACKROCK INC');
  expect((await dbError(c, M, [n, '0001364742x']))?.code).toBe('23505'); // 'BlackRock, Inc.' cae en la misma clave que 'BLACKROCK INC'
}));

test('source_sector_map: la industria destino tiene que pertenecer al sector destino', () => inRollback(async (c) => {
  const [fin, tec] = [await id(c, "INSERT INTO sector (code,name) VALUES ('fin_t','Financials') RETURNING sector_id AS id"), await id(c, "INSERT INTO sector (code,name) VALUES ('tec_t','Tecnología') RETURNING sector_id AS id")];
  const bank = await id(c, "INSERT INTO industry (sector_id, code, name) VALUES ($1,'bank_t','Banking') RETURNING industry_id AS id", [fin]);
  const M = "INSERT INTO source_sector_map (provider, provider_sector_label, provider_industry_label, sector_id, industry_id) VALUES ('eodhd',$1,$2,$3,$4)";
  await c.query(M, ['Financial Services', 'Banks - Diversified', fin, bank]); // sector + industria coherentes
  await c.query(M, ['Financial Services', '', fin, null]); // solo sector (industria no mapeable); '' = sin industria
  expect((await dbError(c, M, ['Technology', 'Banks - Diversified', tec, bank]))?.code).toBe('23503'); // industria de otro sector
  expect((await dbError(c, M, ['Financial Services', 'Banks - Diversified', fin, bank]))?.code).toBe('23505');
  expect((await dbError(c, M, ['X', 'Y', 999999, null]))?.code).toBe('23503');
  expect((await dbError(c, M, ['X', 'Y', null, null]))?.code).toBe('23502'); // sector_id siempre
  expect((await dbError(c, "INSERT INTO source_sector_map (provider, provider_sector_label, sector_id) VALUES ('eodhd','Solo sector',$1)", [fin]))).toBeNull(); // industria '' por defecto
}));

test('company: sector e industria que casan pasan, discrepantes fallan; con solo uno puesto no se comprueba nada', () => inRollback(async (c) => {
  const fin = await id(c, "INSERT INTO sector (code,name) VALUES ('fin_c','Financials') RETURNING sector_id AS id");
  const tec = await id(c, "INSERT INTO sector (code,name) VALUES ('tec_c','Tecnología') RETURNING sector_id AS id");
  const bank = await id(c, "INSERT INTO industry (sector_id, code, name) VALUES ($1,'bank_c','Banking') RETURNING industry_id AS id", [fin]);
  const C = "INSERT INTO company (identity_source, sector_id, industry_id) VALUES ('isolated',$1,$2)";
  await c.query(C, [fin, bank]); // ambos puestos y coherentes
  expect((await dbError(c, C, [tec, bank]))?.code).toBe('23503'); // ambos puestos y discrepantes
  await c.query(C, [fin, null]); // solo sector
  await c.query(C, [tec, null]);
  await c.query(C, [null, bank]); // solo industria (conocimiento parcial)
  await c.query(C, [null, null]); // ninguno
  // UPDATE: mover una company a un sector que no es el de su industria también falla
  const co = await id(c, "INSERT INTO company (identity_source, sector_id, industry_id) VALUES ('isolated',$1,$2) RETURNING company_id AS id", [fin, bank]);
  expect((await dbError(c, 'UPDATE company SET sector_id=$1 WHERE company_id=$2', [tec, co]))?.code).toBe('23503');
  expect((await dbError(c, 'UPDATE company SET sector_id=NULL WHERE company_id=$1', [co]))).toBeNull(); // quitar el sector: queda solo industria
  // las FK simples de 002 siguen vigentes
  expect((await dbError(c, C, [999999, null]))?.code).toBe('23503');
  expect((await dbError(c, C, [null, 999999]))?.code).toBe('23503');
}));
