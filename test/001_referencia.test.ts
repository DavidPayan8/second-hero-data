import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); });
afterAll(closePool);

test('existen las 4 tablas de referencia', async () => {
  const { rows } = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY 1",
    [['asset_type', 'exchange', 'sector', 'industry']],
  );
  expect(rows.map((r) => r.table_name)).toEqual(['asset_type', 'exchange', 'industry', 'sector']);
});

test('asset_type: code único y flags obligatorios', () => inRollback(async (c) => {
  await c.query("INSERT INTO asset_type (code, in_screener_scope, requires_company) VALUES ('t_stock', true, true)");
  expect((await dbError(c, "INSERT INTO asset_type (code, in_screener_scope, requires_company) VALUES ('t_stock', true, true)"))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO asset_type (code, in_screener_scope) VALUES ('t_etf', true)"))?.code).toBe('23502');
}));

const EXCHANGE_OK = "INSERT INTO exchange (mic, country_iso, default_currency, timezone, close_time) VALUES ('XTST','US','USD','America/New_York','16:00')";

test('exchange: mic único y las cinco columnas obligatorias', () => inRollback(async (c) => {
  await c.query(EXCHANGE_OK);
  expect((await dbError(c, EXCHANGE_OK))?.code).toBe('23505');
  const { rows } = await c.query("SELECT close_time::text AS t FROM exchange WHERE mic='XTST'");
  expect(rows[0].t).toBe('16:00:00');
  for (const col of ['country_iso', 'default_currency', 'timezone', 'close_time']) {
    const cols = ['mic', 'country_iso', 'default_currency', 'timezone', 'close_time'].filter((x) => x !== col);
    const vals = { mic: "'X1'", country_iso: "'US'", default_currency: "'USD'", timezone: "'UTC'", close_time: "'16:00'" } as Record<string, string>;
    const sql = `INSERT INTO exchange (${cols.join(',')}) VALUES (${cols.map((x) => vals[x]).join(',')})`;
    expect((await dbError(c, sql))?.code, `falta ${col}`).toBe('23502');
  }
}));

test('exchange: country_iso solo ISO alfa-2 en mayúsculas', () => inRollback(async (c) => {
  for (const bad of ['USA', 'us', 'U', '', 'U1']) {
    const err = await dbError(c, "INSERT INTO exchange (mic, country_iso, default_currency, timezone, close_time) VALUES ('XBAD',$1,'USD','UTC','16:00')", [bad]);
    expect(err?.code, `country_iso=${bad}`).toBe('23514');
  }
}));

const BAD_TIMEZONES = "SELECT mic FROM exchange WHERE timezone NOT IN (SELECT name FROM pg_timezone_names) ORDER BY mic";

test('exchange: todas las timezone existen en pg_timezone_names', async () => {
  const { rows } = await pool.query(BAD_TIMEZONES);
  expect(rows).toEqual([]);
});

test('la comprobación de timezone detecta una zona inválida', () => inRollback(async (c) => {
  await c.query("INSERT INTO exchange (mic, country_iso, default_currency, timezone, close_time) VALUES ('XOK','US','USD','America/New_York','16:00'), ('XKO','US','USD','America/Nueva_York','16:00')");
  const { rows } = await c.query(BAD_TIMEZONES);
  expect(rows).toEqual([{ mic: 'XKO' }]);
}));

test('sector/industry: code únicos e industria exige sector existente', () => inRollback(async (c) => {
  const { rows } = await c.query<{ sector_id: string }>("INSERT INTO sector (code, name) VALUES ('test_sector','Sector de prueba') RETURNING sector_id");
  const sid = rows[0]!.sector_id;
  await c.query("INSERT INTO industry (sector_id, code, name) VALUES ($1,'test_industry','Industria de prueba')", [sid]);
  expect((await dbError(c, "INSERT INTO industry (sector_id, code, name) VALUES ($1,'test_industry','Otra')", [sid]))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO industry (sector_id, code, name) VALUES (999999,'x','X')"))?.code).toBe('23503');
  expect((await dbError(c, "INSERT INTO sector (code, name) VALUES ('test_sector','Dup')"))?.code).toBe('23505');
  expect((await dbError(c, 'DELETE FROM sector WHERE sector_id=$1', [sid]))?.code).toBe('23503');
}));
