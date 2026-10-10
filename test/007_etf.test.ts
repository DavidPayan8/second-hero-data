import type pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const id = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
// Un ETF: security con asset_type etf y company_id NULL.
const etf = (c: pg.PoolClient) =>
  id(c, "INSERT INTO security (company_id, asset_type_id) VALUES (NULL, (SELECT asset_type_id FROM asset_type WHERE code='etf')) RETURNING security_id AS id");
const sector = (c: pg.PoolClient, code = 'tech') => id(c, "INSERT INTO sector (code, name) VALUES ($1,'Tecnología') RETURNING sector_id AS id", [code]);

test('existen las 4 tablas de ETF', async () => {
  const names = ['etf_profile', 'etf_nav_daily', 'etf_holding', 'etf_allocation'];
  const { rows } = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY 1", [names]);
  expect(rows.map((r) => r.table_name)).toEqual([...names].sort());
});

test('etf_profile: PK = security_id (1:1), todo lo demás nullable, expense_ratio numeric', () => inRollback(async (c) => {
  const s = await etf(c);
  await c.query('INSERT INTO etf_profile (security_id) VALUES ($1)', [s]);
  expect((await dbError(c, 'INSERT INTO etf_profile (security_id) VALUES ($1)', [s]))?.code).toBe('23505');
  expect((await dbError(c, 'INSERT INTO etf_profile (security_id) VALUES (999999)'))?.code).toBe('23503');
  expect((await dbError(c, 'INSERT INTO etf_profile (issuer) VALUES (NULL)'))?.code).toBe('23502');
  const s2 = await etf(c);
  await c.query("INSERT INTO etf_profile (security_id, issuer, inception_date, index_tracked, category, domicile, expense_ratio) VALUES ($1,'Vanguard','2001-05-24',NULL,NULL,'United States',0.00030)", [s2]);
  expect((await c.query('SELECT expense_ratio::text AS e FROM etf_profile WHERE security_id=$1', [s2])).rows[0].e).toBe('0.00030');
}));

test('etf_nav_daily: PK (security, date); nav y nav_currency obligatorios; aum y acciones nullable', () => inRollback(async (c) => {
  const s = await etf(c);
  const N = "INSERT INTO etf_nav_daily (security_id, date, nav, nav_currency) VALUES ($1,'2026-10-09',$2,$3)";
  await c.query(N, [s, 312.4567, 'USD']);
  expect((await dbError(c, N, [s, 1, 'USD']))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO etf_nav_daily (security_id, date, nav_currency) VALUES ($1,'2026-10-08','USD')", [s]))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO etf_nav_daily (security_id, date, nav) VALUES ($1,'2026-10-08',1)", [s]))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO etf_nav_daily (security_id, date, nav, nav_currency) VALUES (999999,'2026-10-08',1,'USD')"))?.code).toBe('23503');
  await c.query("INSERT INTO etf_nav_daily (security_id, date, nav, nav_currency, aum, shares_outstanding_etf) VALUES ($1,'2026-10-07',312.1,'USD',462571412072.5,1480000000.5)", [s]);
}));

const H = "INSERT INTO etf_holding (security_id, as_of_date, constituent_security_id, constituent_isin, constituent_name, weight_pct) VALUES ($1,'2026-10-01',$2,$3,$4,$5)";

test('etf_holding: weight_pct obligatorio y al menos un identificador del constituyente', () => inRollback(async (c) => {
  const e = await etf(c);
  expect((await dbError(c, H, [e, null, null, null, 1]))?.message).toContain('etf_holding_has_constituent');
  expect((await dbError(c, H, [e, null, null, 'Apple Inc', null]))?.code).toBe('23502');
  expect((await dbError(c, H, [999999, null, null, 'Apple Inc', 5.94]))?.code).toBe('23503');
  expect((await dbError(c, H, [e, 999999, null, null, 5.94]))?.code).toBe('23503');
  await c.query("INSERT INTO etf_holding (security_id, as_of_date, constituent_name, weight_pct, market_value, shares_held) VALUES ($1,'2026-10-01','Apple Inc',5.94,NULL,NULL)", [e]);
}));

test('etf_holding: clave (ETF, constituyente resuelto > isin > nombre, as_of_date)', () => inRollback(async (c) => {
  const e = await etf(c);
  const aapl = await etf(c); // cualquier security sirve como constituyente
  const msft = await etf(c);
  await c.query(H, [e, aapl, 'US0378331005', 'Apple Inc', 5.94]);
  expect((await dbError(c, H, [e, aapl, null, null, 1]))?.code).toBe('23505'); // mismo constituyente resuelto
  expect((await dbError(c, H, [e, aapl, 'OTRO', 'Otro nombre', 1]))?.code).toBe('23505'); // isin/nombre no importan si hay security
  await c.query(H, [e, msft, null, null, 5.5]);
  await c.query(H, [e, null, 'US5949181045', 'Microsoft', 3]); // sin resolver: la clave es el isin
  expect((await dbError(c, H, [e, null, 'US5949181045', 'Microsoft Corp', 3]))?.code).toBe('23505');
  await c.query(H, [e, null, null, 'Bono 2031', 0.5]); // sin isin: la clave es el nombre
  expect((await dbError(c, H, [e, null, null, 'Bono 2031', 0.6]))?.code).toBe('23505');
  await c.query(H, [e, null, null, '5', 0.1]); await c.query(H, [e, null, 'i:5', null, 0.1]); // prefijos: un nombre '5' no choca con ids
  await c.query("INSERT INTO etf_holding (security_id, as_of_date, constituent_name, weight_pct) VALUES ($1,'2026-11-01','Bono 2031',0.5)", [e]); // otra fecha
  const e2 = await etf(c);
  await c.query(H, [e2, aapl, 'US0378331005', 'Apple Inc', 2]); // otro ETF
}));

const A = "INSERT INTO etf_allocation (security_id, as_of_date, dimension, bucket, sector_id, weight_pct, source) VALUES ($1,'2026-10-01',$2,$3,$4,$5,$6)";

test('etf_allocation: dimension y source en dominio, clave única y campos obligatorios', () => inRollback(async (c) => {
  const e = await etf(c);
  await c.query(A, [e, 'sector', 'Technology', null, 31.2, 'provider']);
  expect((await dbError(c, A, [e, 'sector', 'Technology', null, 99, 'provider']))?.code).toBe('23505');
  await c.query(A, [e, 'country', 'Technology', null, 1, 'provider']); // misma etiqueta, otra dimensión
  await c.query(A, [e, 'asset_type', 'Stock', null, 99.5, 'derived']);
  expect((await dbError(c, A, [e, 'region', 'North America', null, 99, 'provider']))?.code).toBe('23514'); // dimensión que el modelo no define
  expect((await dbError(c, A, [e, 'sector', 'Energy', null, 1, 'manual']))?.code).toBe('23514');
  expect((await dbError(c, A, [e, 'sector', 'Energy', null, null, 'provider']))?.code).toBe('23502');
  expect((await dbError(c, A, [e, 'sector', null, null, 1, 'provider']))?.code).toBe('23502');
  expect((await dbError(c, A, [999999, 'sector', 'Energy', null, 1, 'provider']))?.code).toBe('23503');
}));

test('etf_allocation: sector_id canónico solo con dimension sector; FK a sector; bucket sin mapear queda NULL', () => inRollback(async (c) => {
  const e = await etf(c);
  const tech = await sector(c);
  await c.query(A, [e, 'sector', 'Technology', tech, 31.2, 'provider']);
  await c.query(A, [e, 'sector', 'Consumer Cyclicals', null, 10.3, 'provider']); // sin mapeo: SECTOR_UNMAPPED lo emite el escritor
  expect((await dbError(c, A, [e, 'country', 'United States', tech, 99, 'provider']))?.message).toContain('etf_allocation_sector_only_for_sector');
  expect((await dbError(c, A, [e, 'asset_type', 'Stock', tech, 99, 'provider']))?.message).toContain('etf_allocation_sector_only_for_sector');
  expect((await dbError(c, A, [e, 'sector', 'Energy', 999999, 5, 'provider']))?.code).toBe('23503');
  expect((await dbError(c, 'DELETE FROM sector WHERE sector_id=$1', [tech]))?.code).toBe('23503');
}));

test('ETF_ALLOCATION usa el mismo SECTOR que las empresas (vocabulario unificado)', () => inRollback(async (c) => {
  const tech = await sector(c, 'tech2');
  const e = await etf(c);
  await c.query(A, [e, 'sector', 'Technology', tech, 31.2, 'provider']);
  const co = await id(c, "INSERT INTO company (identity_source, sector_id) VALUES ('isolated', $1) RETURNING company_id AS id", [tech]);
  const { rows } = await c.query('SELECT (SELECT sector_id FROM company WHERE company_id=$1) = (SELECT sector_id FROM etf_allocation WHERE security_id=$2) AS igual', [co, e]);
  expect(rows[0].igual).toBe(true);
}));
