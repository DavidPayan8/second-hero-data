import type pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const id = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
const company = (c: pg.PoolClient, name = 'Acme') => id(c, "INSERT INTO company (legal_name, identity_source) VALUES ($1,'isolated') RETURNING company_id AS id", [name]);
const typeId = (c: pg.PoolClient, code: string) => id(c, 'SELECT asset_type_id AS id FROM asset_type WHERE code=$1', [code]);

// ---------------------------------------------------------------- estructura
test('dimension_audit.row_key: jsonb NOT NULL, solo objetos, indexada; row_id ya no existe', async () => {
  const cols = (await pool.query<{ column_name: string; data_type: string; is_nullable: string }>("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='dimension_audit'")).rows;
  expect(cols.find((x) => x.column_name === 'row_key')).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
  expect(cols.some((x) => x.column_name === 'row_id')).toBe(false);
  const idx = (await pool.query("SELECT pg_get_indexdef('dimension_audit_row_idx'::regclass) AS d")).rows[0].d;
  expect(idx).toContain('(table_name, row_key)');
});

test('row_key y target_key solo admiten objetos JSON', () => inRollback(async (c) => {
  const A = "INSERT INTO dimension_audit (change_set_id, table_name, row_key, column_name, op) VALUES (gen_random_uuid(),'x',$1::jsonb,'c','update')";
  await c.query(A, ['{"company_id": 1}']);
  await c.query(A, ['{"provider": "eodhd", "provider_code": "US"}']); // PK compuesta
  for (const bad of ['1', '"company_id"', '[1]', 'null', 'true']) {
    expect((await dbError(c, A, [bad]))?.message, bad).toContain('dimension_audit_row_key_is_object');
  }
  expect((await dbError(c, "INSERT INTO dimension_audit (change_set_id, table_name, column_name, op) VALUES (gen_random_uuid(),'x','c','update')"))?.code).toBe('23502');
  const F = "INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key) VALUES ('YOY_JUMP','warning','prices_daily',$1::jsonb)";
  await c.query(F, ['{"listing_id": 7, "date": "2026-10-09"}']);
  for (const bad of ['7', '[7]', 'null']) {
    expect((await dbError(c, F, [bad]))?.message, bad).toContain('data_quality_finding_target_key_is_object');
  }
  expect((await dbError(c, "INSERT INTO data_quality_finding (rule_code, severity, target_table) VALUES ('YOY_JUMP','warning','x')"))?.code).toBe('23502');
}));

// ---------------------------------------------------------------- T4 en 13 tablas con row_key
test('T4 está en las 13 dimensiones', async () => {
  const { rows } = await pool.query<{ t: string }>("SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname LIKE 'audit\\_%' AND NOT g.tgisinternal ORDER BY 1");
  expect(rows.map((r) => r.t)).toEqual([
    'asset_type', 'company', 'etf_profile', 'exchange', 'industry', 'listing', 'sector', 'security',
    'source_exchange', 'source_holder_map', 'source_sector_map', 'source_venue_map', 'validation_rule',
  ]);
  expect(rows).toHaveLength(13);
});

const keyOf = async (c: pg.PoolClient, table: string) =>
  (await c.query('SELECT DISTINCT row_key FROM dimension_audit WHERE table_name=$1', [table])).rows.map((r) => r.row_key);

test('audit de una PK de una columna bigint: {"company_id": n} con el número como número', () => inRollback(async (c) => {
  const co = await company(c);
  await c.query("UPDATE company SET legal_name='Otro' WHERE company_id=$1", [co]);
  const { rows } = await c.query("SELECT row_key, jsonb_typeof(row_key->'company_id') AS tipo FROM dimension_audit WHERE table_name='company' AND row_key = jsonb_build_object('company_id', $1::bigint)", [co]);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].tipo).toBe('number');
  expect(rows[0].row_key).toEqual({ company_id: Number(co) });
}));

test('audit de una PK compuesta de texto (source_venue_map)', () => inRollback(async (c) => {
  const k = { provider: 'eodhd', provider_code: 'US', provider_venue_label: 'EtiquetaNueva' };
  await c.query("INSERT INTO source_venue_map (provider, provider_code, provider_venue_label, mic) VALUES ('eodhd','US','EtiquetaNueva','XNAS')");
  await c.query("UPDATE source_venue_map SET mic='XNYS' WHERE provider_venue_label='EtiquetaNueva'"); // corregir un mapeo de MIC
  await c.query("DELETE FROM source_venue_map WHERE provider_venue_label='EtiquetaNueva'");
  const { rows } = await c.query("SELECT column_name, old_value, new_value, op, row_key FROM dimension_audit WHERE table_name='source_venue_map' AND row_key = $1::jsonb ORDER BY dimension_audit_id", [JSON.stringify(k)]);
  expect(rows.every((r) => JSON.stringify(Object.keys(r.row_key).sort()) === JSON.stringify(['provider', 'provider_code', 'provider_venue_label']))).toBe(true);
  const upd = rows.filter((r) => r.op === 'update');
  expect(upd).toHaveLength(1);
  expect(upd[0]).toMatchObject({ column_name: 'mic', old_value: 'XNAS', new_value: 'XNYS' });
  expect(rows.map((r) => r.op)).toEqual(expect.arrayContaining(['insert', 'update', 'delete']));
  // una clave de otra fila no se mezcla
  expect((await c.query("SELECT count(*)::int AS n FROM dimension_audit WHERE table_name='source_venue_map' AND row_key @> '{\"provider_venue_label\": \"NASDAQ\"}' AND column_name='mic'")).rows[0].n).toBe(1); // solo el alta del seed
}));

test('audit de una PK de texto (validation_rule): apagar una regla queda registrado', () => inRollback(async (c) => {
  await c.query("SELECT set_config('app.actor', 'david', true), set_config('app.reason', 'regla ruidosa', true)");
  await c.query("UPDATE validation_rule SET enabled=false, default_severity='info' WHERE rule_code='YOY_JUMP'");
  const { rows } = await c.query("SELECT column_name, old_value, new_value, op, changed_by, reason FROM dimension_audit WHERE table_name='validation_rule' AND row_key = '{\"rule_code\": \"YOY_JUMP\"}'::jsonb AND op = 'update' ORDER BY column_name");
  expect(rows.map((r) => [r.column_name, r.old_value, r.new_value])).toEqual([['default_severity', 'warning', 'info'], ['enabled', 'true', 'false']]);
  expect(rows.every((r) => r.op === 'update' && r.changed_by === 'david' && r.reason === 'regla ruidosa')).toBe(true);
}));

test('audit de source_exchange, source_holder_map y source_sector_map', () => inRollback(async (c) => {
  await c.query("UPDATE source_exchange SET default_mic='XNYS' WHERE provider='eodhd' AND provider_code='LSE'");
  expect((await keyOf(c, 'source_exchange'))).toEqual(expect.arrayContaining([{ provider: 'eodhd', provider_code: 'LSE' }]));
  await c.query("INSERT INTO source_holder_map (provider, holder_name_norm, holder_ref) VALUES ('eodhd','BLACKROCK INC','0001364742')");
  expect(await keyOf(c, 'source_holder_map')).toEqual([{ provider: 'eodhd', holder_name_norm: 'BLACKROCK INC' }]);
  const fin = await id(c, "INSERT INTO sector (code,name) VALUES ('k13','F') RETURNING sector_id AS id");
  await c.query("INSERT INTO source_sector_map (provider, provider_sector_label, sector_id) VALUES ('eodhd','Financial Services',$1)", [fin]);
  expect(await keyOf(c, 'source_sector_map')).toEqual([{ provider: 'eodhd', provider_sector_label: 'Financial Services', provider_industry_label: '' }]);
}));

test('los seeds no dejan filas nuevas en dimension_audit al relanzarse (idempotencia)', async () => {
  const n = async () => (await pool.query('SELECT count(*)::int AS n FROM dimension_audit')).rows[0].n;
  const antes = await n();
  await seed();
  await seed();
  expect(await n()).toBe(antes);
  // y el primer seed sí dejó rastro de las altas en las dimensiones nuevas
  expect((await pool.query("SELECT count(*)::int AS n FROM dimension_audit WHERE table_name IN ('source_exchange','source_venue_map','validation_rule') AND op='insert'")).rows[0].n).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- merge
test('merge: app.op = merge con motivo marca como merge solo las filas de UPDATE; INSERT y DELETE conservan su op', () => inRollback(async (c) => {
  const [a, b] = [await company(c, 'Isolated A'), await company(c, 'Empresa B')];
  const sec = await id(c, 'INSERT INTO security (company_id, asset_type_id) VALUES ($1,$2) RETURNING security_id AS id', [a, await typeId(c, 'common_stock')]);
  await c.query("SELECT set_config('app.actor', 'david', true), set_config('app.reason', 'misma empresa: mismo CIK', true), set_config('app.op', 'merge', true)");
  await c.query('UPDATE security SET company_id=$1 WHERE security_id=$2', [b, sec]); // re-apuntar la security
  await c.query('DELETE FROM company WHERE company_id=$1', [a]); // retirar la company sobrante
  await c.query("INSERT INTO sector (code, name) VALUES ('merge13','S')"); // un INSERT en la misma transacción
  const s = (await c.query("SELECT column_name, old_value, new_value, op, reason, change_set_id FROM dimension_audit WHERE table_name='security' AND row_key = jsonb_build_object('security_id', $1::bigint) AND column_name='company_id' AND op <> 'insert'", [sec])).rows;
  expect(s).toHaveLength(1);
  expect(s[0]).toMatchObject({ column_name: 'company_id', old_value: a, new_value: b, op: 'merge', reason: 'misma empresa: mismo CIK' });
  const del = (await c.query("SELECT DISTINCT op FROM dimension_audit WHERE table_name='company' AND row_key = jsonb_build_object('company_id', $1::bigint) AND op <> 'insert'", [a])).rows;
  expect(del).toEqual([{ op: 'delete' }]); // el DELETE conserva su op
  const ins = (await c.query("SELECT DISTINCT op FROM dimension_audit WHERE table_name='sector' AND column_name='code' AND new_value='merge13'")).rows;
  expect(ins).toEqual([{ op: 'insert' }]); // el INSERT conserva su op
  // todo comparte change_set_id: la fusión se reconstruye por él
  const cs = (await c.query("SELECT count(DISTINCT change_set_id)::int AS n FROM dimension_audit WHERE (table_name='security' AND row_key = jsonb_build_object('security_id', $1::bigint) AND op='merge') OR (table_name='company' AND row_key = jsonb_build_object('company_id', $2::bigint) AND op='delete')", [sec, a])).rows[0].n;
  expect(cs).toBe(1);
}));

test('merge sin motivo -> error; con motivo vacío también', () => inRollback(async (c) => {
  const [a, b] = [await company(c), await company(c, 'B')];
  const sec = await id(c, 'INSERT INTO security (company_id, asset_type_id) VALUES ($1,$2) RETURNING security_id AS id', [a, await typeId(c, 'common_stock')]);
  await c.query("SELECT set_config('app.op', 'merge', true)");
  const err = await dbError(c, 'UPDATE security SET company_id=$1 WHERE security_id=$2', [b, sec]);
  expect(err?.message).toContain('app.reason');
  expect(err?.code).toBe('23514');
  await c.query("SELECT set_config('app.reason', '', true)");
  expect((await dbError(c, 'UPDATE security SET company_id=$1 WHERE security_id=$2', [b, sec]))?.message).toContain('app.reason');
  // incluso un INSERT en una dimensión auditada falla: app.op = merge exige motivo en toda la transacción
  expect((await dbError(c, "INSERT INTO sector (code, name) VALUES ('sin_motivo','S')"))?.message).toContain('app.reason');
  await c.query("SELECT set_config('app.reason', 'motivo', true)");
  await c.query('UPDATE security SET company_id=$1 WHERE security_id=$2', [b, sec]); // con motivo, pasa
}));

test('otro valor de app.op -> error', () => inRollback(async (c) => {
  await c.query("SELECT set_config('app.reason', 'x', true)");
  for (const v of ['update', 'MERGE', 'delete', 'merge ']) {
    await c.query("SELECT set_config('app.op', $1, true)", [v]);
    const err = await dbError(c, "INSERT INTO sector (code, name) VALUES ('op_raro','S')");
    expect(err?.message, v).toContain('app.op');
    expect(err?.code, v).toBe('22023');
  }
  await c.query("SELECT set_config('app.op', '', true)"); // vacío = sin marca
  await c.query("INSERT INTO sector (code, name) VALUES ('op_vacio','S')");
}));

// ---------------------------------------------------------------- findings
const F = "INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detail) VALUES ('YOY_JUMP','warning','prices_daily',$1::jsonb,$2::jsonb)";
const K = '{"listing_id": 7, "date": "2026-10-09"}';

test('un segundo finding abierto con la misma regla y objetivo falla; uno nuevo tras cerrar el anterior pasa', () => inRollback(async (c) => {
  await c.query(F, [K, '{"v": 1}']);
  expect((await dbError(c, F, [K, '{"v": 2}']))?.code).toBe('23505');
  expect((await dbError(c, F, ['{"date": "2026-10-09", "listing_id": 7}', '{"v": 2}']))?.code).toBe('23505'); // el orden de las claves no importa
  await c.query(F, ['{"listing_id": 7, "date": "2026-10-10"}', null]); // otro objetivo
  await c.query("INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key) VALUES ('STALENESS','warning','prices_daily',$1::jsonb)", [K]); // otra regla
  await c.query("UPDATE data_quality_finding SET status='accepted', resolved_at=now(), resolved_by='david' WHERE rule_code='YOY_JUMP' AND target_key=$1::jsonb", [K]);
  await c.query(F, [K, '{"v": 3}']); // tras cerrar el anterior, uno nuevo pasa
  expect((await dbError(c, F, [K, '{"v": 4}']))?.code).toBe('23505'); // y vuelve a haber solo uno abierto
  const { rows } = await c.query("SELECT status FROM data_quality_finding WHERE rule_code='YOY_JUMP' AND target_key=$1::jsonb ORDER BY finding_id", [K]);
  expect(rows.map((r) => r.status)).toEqual(['accepted', 'open']); // el cerrado queda como historia
}));

test('el productor puede usar ON CONFLICT sobre el índice parcial para actualizar el detail del abierto', () => inRollback(async (c) => {
  const UP = `INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detail) VALUES ('YOY_JUMP','warning','prices_daily',$1::jsonb,$2::jsonb)
              ON CONFLICT (rule_code, target_table, target_key) WHERE status = 'open' DO UPDATE SET detail = EXCLUDED.detail RETURNING finding_id AS id`;
  const first = await id(c, UP, [K, '{"v": 1}']);
  const detectedAt = (await c.query('SELECT detected_at FROM data_quality_finding WHERE finding_id=$1', [first])).rows[0].detected_at;
  const second = await id(c, UP, [K, '{"v": 2}']);
  expect(second).toBe(first); // misma fila
  const row = (await c.query('SELECT detail, detected_at FROM data_quality_finding WHERE finding_id=$1', [first])).rows[0];
  expect(row.detail).toEqual({ v: 2 });
  expect(row.detected_at).toEqual(detectedAt); // detected_at conserva la primera detección
  expect((await c.query('SELECT count(*)::int AS n FROM data_quality_finding')).rows[0].n).toBe(1);
}));

test('cerrar sin resolved_at o sin resolved_by falla; abrir con ellos informados también', () => inRollback(async (c) => {
  await c.query(F, [K, null]);
  const close = (set: string) => dbError(c, `UPDATE data_quality_finding SET ${set} WHERE rule_code='YOY_JUMP'`);
  for (const st of ['reviewed', 'accepted', 'dismissed']) {
    expect((await close(`status='${st}'`))?.message, st).toContain('data_quality_finding_resolved_');
    expect((await close(`status='${st}', resolved_at=now()`))?.message, `${st} sin resolved_by`).toContain('data_quality_finding_resolved_by_iff_closed');
    expect((await close(`status='${st}', resolved_by='david'`))?.message, `${st} sin resolved_at`).toContain('data_quality_finding_resolved_at_iff_closed');
  }
  // abierto con resolved_* informados
  expect((await close("resolved_at=now()"))?.message).toContain('data_quality_finding_resolved_at_iff_closed');
  expect((await close("resolved_by='david'"))?.message).toContain('data_quality_finding_resolved_by_iff_closed');
  // cerrado con todo: pasa, para cada estado de cierre
  for (const st of ['reviewed', 'accepted', 'dismissed']) {
    await c.query("DELETE FROM data_quality_finding");
    await c.query(F, [K, null]);
    await c.query(`UPDATE data_quality_finding SET status='${st}', resolved_at=now(), resolved_by='david'`);
  }
  // INSERT directo ya cerrado sin resolved_*
  expect((await dbError(c, "INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, status) VALUES ('STALENESS','info','security','{\"security_id\": 1}','dismissed')"))?.message).toContain('data_quality_finding_resolved_');
}));

test('target_key de prices_daily construido en SQL desde la propia fila', () => inRollback(async (c) => {
  const co = await company(c);
  const sec = await id(c, 'INSERT INTO security (company_id, asset_type_id) VALUES ($1,$2) RETURNING security_id AS id', [co, await typeId(c, 'common_stock')]);
  const lst = await id(c, "INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency, status) VALUES ($1,'T','T13.US','USD','active') RETURNING listing_id AS id", [sec]);
  await c.query("INSERT INTO prices_daily (listing_id, date, close) VALUES ($1,'2026-10-09',100), ($1,'2026-10-08',1000)", [lst]); // salto de x10
  await c.query(`INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detail)
                 SELECT 'YOY_JUMP', 'warning', 'prices_daily', jsonb_build_object('listing_id', p.listing_id, 'date', p.date), jsonb_build_object('close', p.close)
                 FROM prices_daily p WHERE p.listing_id = $1 AND p.date = '2026-10-09'`, [lst]);
  const { rows } = await c.query("SELECT target_key, jsonb_typeof(target_key->'listing_id') AS t1, jsonb_typeof(target_key->'date') AS t2 FROM data_quality_finding");
  expect(rows[0].target_key).toEqual({ listing_id: Number(lst), date: '2026-10-09' }); // la fecha, con el formato de Postgres
  expect([rows[0].t1, rows[0].t2]).toEqual(['number', 'string']);
  // se vuelve a la fila con la clave: join exacto
  const j = await c.query(`SELECT p.close::text AS close FROM data_quality_finding f
                           JOIN prices_daily p ON p.listing_id = (f.target_key->>'listing_id')::bigint AND p.date = (f.target_key->>'date')::date
                           WHERE f.target_table = 'prices_daily'`);
  expect(j.rows).toEqual([{ close: '100' }]);
  // el mismo objetivo construido otra vez en SQL es idéntico: el índice único parcial lo reconoce
  expect((await dbError(c, `INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key)
                            SELECT 'YOY_JUMP', 'warning', 'prices_daily', jsonb_build_object('listing_id', p.listing_id, 'date', p.date)
                            FROM prices_daily p WHERE p.listing_id = $1 AND p.date = '2026-10-09'`, [lst]))?.code).toBe('23505');
}));
