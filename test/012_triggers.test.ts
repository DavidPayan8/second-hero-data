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
const SEC = 'INSERT INTO security (company_id, asset_type_id) VALUES ($1,$2) RETURNING security_id AS id';
const PK: Record<string, string> = {
  company: 'company_id', security: 'security_id', listing: 'listing_id', exchange: 'exchange_id',
  asset_type: 'asset_type_id', etf_profile: 'security_id', sector: 'sector_id', industry: 'industry_id',
};
const audit = async (c: pg.PoolClient, table: string, rowId: string) =>
  (await c.query('SELECT column_name, old_value, new_value, op, change_set_id, changed_by, reason FROM dimension_audit WHERE table_name=$1 AND row_key = jsonb_build_object($2::text, $3::bigint) ORDER BY dimension_audit_id', [table, PK[table], rowId])).rows;

// ---------------------------------------------------------------- T1
test('A2: acción sin company -> error; ETF con company -> error; los casos válidos pasan', () => inRollback(async (c) => {
  const [stock, etf] = [await typeId(c, 'common_stock'), await typeId(c, 'etf')];
  const co = await company(c);
  expect((await dbError(c, SEC, [null, stock]))?.message).toContain('exige company_id'); // acción sin company
  expect((await dbError(c, SEC, [null, stock]))?.code).toBe('23514');
  expect((await dbError(c, SEC, [co, etf]))?.message).toContain('no admite company_id'); // ETF con company
  expect((await dbError(c, SEC, [co, etf]))?.code).toBe('23514');
  await c.query(SEC, [co, stock]); // acción con company
  await c.query(SEC, [null, etf]); // ETF sin company
}));

test('T1 también en UPDATE: no se puede quitar la company a una acción ni ponérsela a un ETF', () => inRollback(async (c) => {
  const [stock, etf] = [await typeId(c, 'common_stock'), await typeId(c, 'etf')];
  const co = await company(c);
  const s = await id(c, SEC, [co, stock]);
  const e = await id(c, SEC, [null, etf]);
  expect((await dbError(c, 'UPDATE security SET company_id=NULL WHERE security_id=$1', [s]))?.code).toBe('23514');
  expect((await dbError(c, 'UPDATE security SET company_id=$1 WHERE security_id=$2', [co, e]))?.code).toBe('23514');
  // cambiar el tipo de activo hacia uno incompatible con la company actual
  expect((await dbError(c, 'UPDATE security SET asset_type_id=$1 WHERE security_id=$2', [etf, s]))?.code).toBe('23514');
  expect((await dbError(c, 'UPDATE security SET asset_type_id=$1 WHERE security_id=$2', [stock, e]))?.code).toBe('23514');
  // una actualización neutra pasa
  await c.query('UPDATE security SET isin=$1 WHERE security_id=$2', ['US0378331005', s]);
}));

test('T1 es dato, no código: un tipo de activo nuevo declara si exige company', () => inRollback(async (c) => {
  const nuevo = await id(c, "INSERT INTO asset_type (code, in_screener_scope, requires_company) VALUES ('t_reit_fund', false, false) RETURNING asset_type_id AS id");
  await c.query(SEC, [null, nuevo]);
  expect((await dbError(c, SEC, [await company(c), nuevo]))?.code).toBe('23514');
}));

test('T1: asset_type inexistente lo rechaza la FK, no el trigger', () => inRollback(async (c) => {
  expect((await dbError(c, SEC, [null, 999999]))?.code).toBe('23503');
  expect((await dbError(c, 'INSERT INTO security (company_id) VALUES ($1)', [await company(c)]))?.code).toBe('23502');
}));

// ---------------------------------------------------------------- T2
test('A3: cambiar requires_company de un tipo con securities -> error; sin securities se puede', () => inRollback(async (c) => {
  const nuevo = await id(c, "INSERT INTO asset_type (code, in_screener_scope, requires_company) VALUES ('t_tipo', true, true) RETURNING asset_type_id AS id");
  // sin securities colgando: se puede cambiar
  await c.query('UPDATE asset_type SET requires_company=false WHERE asset_type_id=$1', [nuevo]);
  await c.query('UPDATE asset_type SET requires_company=true WHERE asset_type_id=$1', [nuevo]);
  await c.query(SEC, [await company(c), nuevo]);
  const err = await dbError(c, 'UPDATE asset_type SET requires_company=false WHERE asset_type_id=$1', [nuevo]);
  expect(err?.code).toBe('23514');
  expect(err?.message).toContain('ya tiene securities');
  // otros campos del tipo sí se pueden tocar aunque tenga securities
  await c.query('UPDATE asset_type SET in_screener_scope=false WHERE asset_type_id=$1', [nuevo]);
  // fijar el mismo valor no es un cambio
  await c.query('UPDATE asset_type SET requires_company=true WHERE asset_type_id=$1', [nuevo]);
}));

test('T2 sobre los tipos sembrados: common_stock y etf ya no pueden invertir su requires_company si tienen securities', () => inRollback(async (c) => {
  const etf = await typeId(c, 'etf');
  await c.query(SEC, [null, etf]);
  expect((await dbError(c, "UPDATE asset_type SET requires_company=true WHERE code='etf'"))?.code).toBe('23514');
}));

// ---------------------------------------------------------------- T4
test('A5: un UPDATE de legal_name y sector_id en una transacción -> 2 filas con el mismo change_set_id, actor y motivo', () => inRollback(async (c) => {
  const tec = await id(c, "INSERT INTO sector (code, name) VALUES ('t4_tec','Tecnología') RETURNING sector_id AS id");
  const co = await company(c, 'Nombre antiguo');
  await c.query("SELECT set_config('app.actor', $1, true), set_config('app.reason', $2, true)", ['david', 'reclasificación manual']);
  await c.query("DELETE FROM dimension_audit WHERE table_name='company' AND row_key = jsonb_build_object('company_id', $1::bigint)", [co]); // ignora las filas del insert
  await c.query("UPDATE company SET legal_name='Nombre nuevo', sector_id=$1 WHERE company_id=$2", [tec, co]);
  const rows = await audit(c, 'company', co);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.column_name).sort()).toEqual(['legal_name', 'sector_id']);
  expect(new Set(rows.map((r) => r.change_set_id)).size).toBe(1);
  expect(rows.every((r) => r.changed_by === 'david' && r.reason === 'reclasificación manual' && r.op === 'update')).toBe(true);
  const ln = rows.find((r) => r.column_name === 'legal_name');
  expect(ln).toMatchObject({ old_value: 'Nombre antiguo', new_value: 'Nombre nuevo' });
  expect(rows.find((r) => r.column_name === 'sector_id')).toMatchObject({ old_value: null, new_value: tec });
}));

test('A5: un UPDATE que no cambia nada -> 0 filas; solo se registran las columnas que cambian', () => inRollback(async (c) => {
  const co = await company(c, 'Acme');
  await c.query("DELETE FROM dimension_audit WHERE table_name='company' AND row_key = jsonb_build_object('company_id', $1::bigint)", [co]);
  await c.query("UPDATE company SET legal_name='Acme' WHERE company_id=$1", [co]); // mismo valor
  await c.query('UPDATE company SET sector_id=NULL WHERE company_id=$1', [co]); // NULL -> NULL
  await c.query("UPDATE company SET country_iso='US', fiscal_year_end_month=9 WHERE company_id=$1", [co]);
  await c.query("UPDATE company SET country_iso='US', fiscal_year_end_month=12 WHERE company_id=$1", [co]); // solo cambia el mes
  const rows = await audit(c, 'company', co);
  expect(rows.map((r) => [r.column_name, r.old_value, r.new_value])).toEqual([
    ['country_iso', null, 'US'], ['fiscal_year_end_month', null, '9'], ['fiscal_year_end_month', '9', '12'],
  ]);
}));

test('T4: change_set_id uno por transacción (estable dentro, distinto entre transacciones) y NULL de actor sin contexto', () => inRollback(async (c) => {
  const a = await company(c, 'A');
  const b = await company(c, 'B');
  const ra = await audit(c, 'company', a);
  const rb = await audit(c, 'company', b);
  expect(new Set([...ra, ...rb].map((r) => r.change_set_id)).size).toBe(1); // misma transacción
  expect([...ra, ...rb].every((r) => r.changed_by === null && r.reason === null)).toBe(true); // corrección directa en SQL
  // en otra transacción, otro change_set_id
  const otra = await pool.connect();
  try {
    await otra.query('BEGIN');
    const x = await company(otra, 'X');
    const rx = await audit(otra, 'company', x);
    expect(rx[0]!.change_set_id).not.toBe(ra[0]!.change_set_id);
    await otra.query('ROLLBACK');
  } finally { otra.release(); }
}));

test('T4: si la aplicación fija app.change_set_id se respeta', () => inRollback(async (c) => {
  const cs = '11111111-2222-3333-4444-555555555555';
  await c.query("SELECT set_config('app.change_set_id', $1, true)", [cs]);
  const co = await company(c);
  const rows = await audit(c, 'company', co);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.change_set_id === cs)).toBe(true);
}));

test('T4: INSERT registra una fila por columna con valor (old NULL) y DELETE una por columna (new NULL)', () => inRollback(async (c) => {
  const co = await id(c, "INSERT INTO company (legal_name, identity_source, country_iso) VALUES ('Borrable','isolated','FR') RETURNING company_id AS id");
  const ins = await audit(c, 'company', co);
  expect(ins.every((r) => r.op === 'insert' && r.old_value === null)).toBe(true);
  expect(ins.map((r) => r.column_name).sort()).toEqual(['company_id', 'country_iso', 'identity_source', 'legal_name']); // las NULL no generan fila
  await c.query("DELETE FROM dimension_audit WHERE table_name='company' AND row_key = jsonb_build_object('company_id', $1::bigint)", [co]);
  await c.query('DELETE FROM company WHERE company_id=$1', [co]);
  const del = await audit(c, 'company', co);
  expect(del.every((r) => r.op === 'delete' && r.new_value === null)).toBe(true);
  expect(del.find((r) => r.column_name === 'legal_name')).toMatchObject({ old_value: 'Borrable' });
}));

test('T4 audita security, listing, exchange, asset_type, etf_profile, sector e industry', () => inRollback(async (c) => {
  const etf = await typeId(c, 'etf');
  const sec = await id(c, SEC, [null, etf]);
  await c.query("UPDATE security SET isin='US0000000001' WHERE security_id=$1", [sec]);
  expect((await audit(c, 'security', sec)).some((r) => r.column_name === 'isin' && r.new_value === 'US0000000001' && r.op === 'update')).toBe(true);

  const lst = await id(c, "INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency, status) VALUES ($1,'T','T4.US','USD','active') RETURNING listing_id AS id", [sec]);
  await c.query("UPDATE listing SET status='delisted' WHERE listing_id=$1", [lst]);
  expect((await audit(c, 'listing', lst)).some((r) => r.column_name === 'status' && r.old_value === 'active' && r.new_value === 'delisted')).toBe(true);

  const ex = await id(c, "INSERT INTO exchange (mic, country_iso, default_currency, timezone, close_time) VALUES ('XTT4','US','USD','UTC','16:00') RETURNING exchange_id AS id");
  await c.query("UPDATE exchange SET close_time='17:00' WHERE exchange_id=$1", [ex]);
  expect((await audit(c, 'exchange', ex)).some((r) => r.column_name === 'close_time' && r.old_value === '16:00:00' && r.new_value === '17:00:00')).toBe(true);

  const at = await id(c, "INSERT INTO asset_type (code, in_screener_scope, requires_company) VALUES ('t4_t', true, true) RETURNING asset_type_id AS id");
  await c.query('UPDATE asset_type SET in_screener_scope=false WHERE asset_type_id=$1', [at]);
  expect((await audit(c, 'asset_type', at)).some((r) => r.column_name === 'in_screener_scope' && r.new_value === 'false')).toBe(true);

  await c.query('INSERT INTO etf_profile (security_id, expense_ratio) VALUES ($1,0.0003)', [sec]);
  await c.query('UPDATE etf_profile SET expense_ratio=0.0005 WHERE security_id=$1', [sec]);
  const ep = (await audit(c, 'etf_profile', sec)).filter((r) => r.column_name === 'expense_ratio');
  expect(ep.map((r) => [r.op, r.old_value, r.new_value])).toEqual([['insert', null, '0.0003'], ['update', '0.0003', '0.0005']]); // historial del expense_ratio

  const se = await id(c, "INSERT INTO sector (code, name) VALUES ('t4_se','S') RETURNING sector_id AS id");
  await c.query("UPDATE sector SET name='Sector renombrado' WHERE sector_id=$1", [se]);
  expect((await audit(c, 'sector', se)).some((r) => r.column_name === 'name' && r.new_value === 'Sector renombrado')).toBe(true);
  const ind = await id(c, "INSERT INTO industry (sector_id, code, name) VALUES ($1,'t4_in','I') RETURNING industry_id AS id", [se]);
  await c.query("UPDATE industry SET name='Industria renombrada' WHERE industry_id=$1", [ind]);
  expect((await audit(c, 'industry', ind)).some((r) => r.column_name === 'name' && r.new_value === 'Industria renombrada')).toBe(true);
}));

test('T4: las tablas de hechos NO se auditan (ya conservan su historial)', () => inRollback(async (c) => {
  const co = await company(c);
  const sec = await id(c, SEC, [co, await typeId(c, 'common_stock')]);
  const before = (await c.query('SELECT count(*)::int AS n FROM dimension_audit')).rows[0].n;
  await c.query("INSERT INTO stock_split (security_id, ex_date, split_numerator, split_denominator) VALUES ($1,'2020-08-31',4,1)", [sec]);
  await c.query("INSERT INTO dividend (security_id, ex_date, amount_native, currency) VALUES ($1,'2026-08-10',0.27,'USD')", [sec]);
  await c.query("INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, currency) VALUES ($1,'2025-12-31','Q','2026-01-30','USD')", [co]);
  await c.query("INSERT INTO news (url, published_at, headline) VALUES ('https://t4/1', now(), 'x')");
  expect((await c.query('SELECT count(*)::int AS n FROM dimension_audit')).rows[0].n).toBe(before);
}));

test('T4 con withActor: el actor y el motivo llegan al log y no se filtran a la transacción siguiente', async () => {
  const { withActor } = await import('../src/db/withActor.js');
  const code = `t4_wa_${Date.now()}`;
  let sectorId = '';
  try {
    sectorId = await withActor('David', 'alta de prueba', async (c) => id(c, 'INSERT INTO sector (code, name) VALUES ($1,$2) RETURNING sector_id AS id', [code, 'Prueba']));
    const rows = (await pool.query('SELECT changed_by, reason FROM dimension_audit WHERE table_name=$1 AND row_key = jsonb_build_object($3::text, $2::bigint)', ['sector', sectorId, 'sector_id'])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.changed_by === 'David' && r.reason === 'alta de prueba')).toBe(true);
    // una corrección directa posterior en SQL no hereda el contexto
    await pool.query("UPDATE sector SET name='Directo' WHERE sector_id=$1", [sectorId]);
    const directo = (await pool.query("SELECT changed_by, reason FROM dimension_audit WHERE table_name='sector' AND row_key = jsonb_build_object('sector_id', $1::bigint) AND column_name='name' AND new_value='Directo'", [sectorId])).rows;
    expect(directo).toEqual([{ changed_by: null, reason: null }]);
  } finally {
    if (sectorId) {
      await pool.query('DELETE FROM sector WHERE sector_id=$1', [sectorId]);
      await pool.query("DELETE FROM dimension_audit WHERE table_name='sector' AND row_key = jsonb_build_object('sector_id', $1::bigint)", [sectorId]);
    }
  }
});
