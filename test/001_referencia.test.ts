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
  await c.query("INSERT INTO asset_type (code, in_screener_scope, requires_company) VALUES ('common_stock', true, true)");
  expect((await dbError(c, "INSERT INTO asset_type (code, in_screener_scope, requires_company) VALUES ('common_stock', true, true)"))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO asset_type (code, in_screener_scope) VALUES ('etf', true)"))?.code).toBe('23502');
}));

test('exchange: mic único', () => inRollback(async (c) => {
  await c.query("INSERT INTO exchange (mic, country_iso, default_currency, timezone, close_time) VALUES ('XNAS','US','USD','America/New_York','16:00')");
  expect((await dbError(c, "INSERT INTO exchange (mic) VALUES ('XNAS')"))?.code).toBe('23505');
  const { rows } = await c.query("SELECT close_time::text AS t FROM exchange WHERE mic='XNAS'");
  expect(rows[0].t).toBe('16:00:00');
}));

test('sector/industry: code únicos e industria exige sector existente', () => inRollback(async (c) => {
  const { rows } = await c.query<{ sector_id: string }>("INSERT INTO sector (code, name) VALUES ('fin','Financials') RETURNING sector_id");
  const sid = rows[0]!.sector_id;
  await c.query("INSERT INTO industry (sector_id, code, name) VALUES ($1,'banking','Banking')", [sid]);
  expect((await dbError(c, "INSERT INTO industry (sector_id, code, name) VALUES ($1,'banking','Otra')", [sid]))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO industry (sector_id, code, name) VALUES (999999,'x','X')"))?.code).toBe('23503');
  expect((await dbError(c, "INSERT INTO sector (code, name) VALUES ('fin','Dup')"))?.code).toBe('23505');
  expect((await dbError(c, 'DELETE FROM sector WHERE sector_id=$1', [sid]))?.code).toBe('23503');
}));
