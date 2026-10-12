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

test('existen las 4 tablas de ETF (etf_snapshot, no etf_nav_daily)', async () => {
  const names = ['etf_profile', 'etf_snapshot', 'etf_holding', 'etf_allocation'];
  const { rows } = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name = ANY($1) OR table_name = 'etf_nav_daily') ORDER BY 1", [names]);
  expect(rows.map((r) => r.table_name)).toEqual([...names].sort());
});

test('etf_profile: PK = security_id (1:1) y todo lo demás nullable', () => inRollback(async (c) => {
  const s = await etf(c);
  await c.query('INSERT INTO etf_profile (security_id) VALUES ($1)', [s]);
  expect((await dbError(c, 'INSERT INTO etf_profile (security_id) VALUES ($1)', [s]))?.code).toBe('23505');
  expect((await dbError(c, 'INSERT INTO etf_profile (security_id) VALUES (999999)'))?.code).toBe('23503');
  expect((await dbError(c, 'INSERT INTO etf_profile (issuer) VALUES (NULL)'))?.code).toBe('23502');
  const s2 = await etf(c);
  await c.query("INSERT INTO etf_profile (security_id, issuer, inception_date, index_tracked, category, domicile, expense_ratio) VALUES ($1,'Vanguard','2001-05-24',NULL,NULL,'United States',0.00030)", [s2]);
  expect((await c.query('SELECT expense_ratio::text AS e FROM etf_profile WHERE security_id=$1', [s2])).rows[0].e).toBe('0.00030');
}));

test('etf_profile.expense_ratio: fracción en [0, 0.1); un porcentaje cae fuera', () => inRollback(async (c) => {
  const P = 'INSERT INTO etf_profile (security_id, expense_ratio) VALUES ($1,$2)';
  for (const ok of [0, 0.0003, 0.0095, 0.09999]) await c.query(P, [await etf(c), ok]); // el 0 se guarda tal cual
  for (const bad of [0.1, 0.2, 20, 1, -0.0001]) {
    expect((await dbError(c, P, [await etf(c), bad]))?.code, `expense_ratio=${bad}`).toBe('23514');
  }
  await c.query(P, [await etf(c), null]); // no informado
}));

test('etf_snapshot: PK (security, as_of_date); aum, nav y acciones nullable; divisa obligatoria si hay aum o nav', () => inRollback(async (c) => {
  const s = await etf(c);
  const N = 'INSERT INTO etf_snapshot (security_id, as_of_date, aum, nav, currency, shares_outstanding_etf) VALUES ($1,$2,$3,$4,$5,$6)';
  await c.query(N, [s, '2026-10-09', 462571412072.5, null, 'USD', null]); // solo aum, como da EODHD
  expect((await dbError(c, N, [s, '2026-10-09', 1, 1, 'USD', 1]))?.code).toBe('23505');
  await c.query(N, [s, '2026-10-10', null, 312.4567, 'USD', null]); // solo nav
  await c.query(N, [s, '2026-10-11', null, null, null, 1480000000.5]); // solo acciones, sin divisa: válido
  await c.query(N, [s, '2026-10-12', null, null, null, null]); // fila vacía: válida
  expect((await dbError(c, N, [s, '2026-10-13', 100, null, null, null]))?.message).toContain('etf_snapshot_amount_has_currency'); // aum sin divisa
  expect((await dbError(c, N, [s, '2026-10-13', null, 100, null, null]))?.message).toContain('etf_snapshot_amount_has_currency'); // nav sin divisa
  expect((await dbError(c, 'INSERT INTO etf_snapshot (security_id, aum, currency) VALUES ($1,1,$2)', [s, 'USD']))?.code).toBe('23502'); // sin as_of_date
  expect((await dbError(c, N, [999999, '2026-10-14', 1, null, 'USD', null]))?.code).toBe('23503');
}));

const H = 'INSERT INTO etf_holding (security_id, as_of_date, constituent_security_id, constituent_symbol, constituent_isin, constituent_name, weight_pct) VALUES ($1,\'2026-10-01\',$2,$3,$4,$5,$6)';

test('etf_holding: weight_pct obligatorio y al menos símbolo, isin o nombre', () => inRollback(async (c) => {
  const e = await etf(c);
  expect((await dbError(c, H, [e, null, null, null, null, 1]))?.message).toContain('etf_holding_has_constituent');
  expect((await dbError(c, H, [e, await etf(c), null, null, null, 1]))?.message).toContain('etf_holding_has_constituent'); // el id resuelto solo no basta
  expect((await dbError(c, H, [e, null, 'AAPL.US', null, null, null]))?.code).toBe('23502'); // sin weight_pct
  expect((await dbError(c, H, [999999, null, 'AAPL.US', null, null, 5.94]))?.code).toBe('23503');
  expect((await dbError(c, H, [e, 999999, 'AAPL.US', null, null, 5.94]))?.code).toBe('23503');
  await c.query("INSERT INTO etf_holding (security_id, as_of_date, constituent_symbol, weight_pct, market_value, shares_held) VALUES ($1,'2026-10-01','AAPL.US',5.94,NULL,NULL)", [e]);
}));

test('etf_holding: clave (ETF, as_of_date, símbolo > isin > nombre), solo identificadores del proveedor', () => inRollback(async (c) => {
  const e = await etf(c);
  const aapl = await etf(c);
  await c.query(H, [e, null, 'AAPL.US', null, 'Apple Inc', 5.94]);
  expect((await dbError(c, H, [e, null, 'AAPL.US', 'US0378331005', 'Otro nombre', 1]))?.code).toBe('23505'); // mismo símbolo; isin y nombre no cuentan
  // la resolución a security_id no forma parte de la clave: resolverlo después no duplica ni cambia nada
  expect((await dbError(c, H, [e, aapl, 'AAPL.US', null, null, 5.94]))?.code).toBe('23505');
  await c.query(H, [e, aapl, 'MSFT.US', null, null, 5.5]);
  await c.query(H, [e, null, null, 'US0378331005', 'Apple Inc', 3]); // sin símbolo: la clave es el isin
  expect((await dbError(c, H, [e, null, null, 'US0378331005', 'Apple Inc.', 3]))?.code).toBe('23505');
  await c.query(H, [e, null, null, null, 'Bono 2031', 0.5]); // sin símbolo ni isin: la clave es el nombre
  expect((await dbError(c, H, [e, null, null, null, 'Bono 2031', 0.6]))?.code).toBe('23505');
  await c.query("INSERT INTO etf_holding (security_id, as_of_date, constituent_name, weight_pct) VALUES ($1,'2026-11-01','Bono 2031',0.5)", [e]); // otra fecha
  const e2 = await etf(c);
  await c.query(H, [e2, null, 'AAPL.US', null, 'Apple Inc', 2]); // otro ETF
}));

const A = "INSERT INTO etf_allocation (security_id, as_of_date, dimension, bucket, sector_id, weight_pct, source) VALUES ($1,'2026-10-01',$2,$3,$4,$5,$6)";

test('etf_allocation: dimension sector|region|market_cap|asset_class, source en dominio, clave única y obligatorios', () => inRollback(async (c) => {
  const e = await etf(c);
  await c.query(A, [e, 'sector', 'Technology', null, 31.2, 'provider']);
  expect((await dbError(c, A, [e, 'sector', 'Technology', null, 99, 'provider']))?.code).toBe('23505');
  for (const dim of ['region', 'market_cap', 'asset_class']) await c.query(A, [e, dim, 'Technology', null, 1, 'provider']); // misma etiqueta, otra dimensión
  await c.query(A, [e, 'region', 'United Kingdom', null, 0.09, 'provider']); // países y regiones, tal cual del proveedor
  for (const bad of ['country', 'asset_type', 'Sector', 'currency']) {
    expect((await dbError(c, A, [e, bad, 'X', null, 1, 'provider']))?.code, bad).toBe('23514');
  }
  expect((await dbError(c, A, [e, 'sector', 'Energy', null, 1, 'manual']))?.code).toBe('23514');
  expect((await dbError(c, A, [e, 'sector', 'Energy', null, null, 'provider']))?.code).toBe('23502');
  expect((await dbError(c, A, [e, 'sector', null, null, 1, 'provider']))?.code).toBe('23502');
  await c.query(A, [e, 'asset_class', 'Stock', null, 99.5, 'derived']);
  expect((await dbError(c, A, [999999, 'sector', 'Energy', null, 1, 'provider']))?.code).toBe('23503');
}));

test('etf_allocation: sector_id canónico solo con dimension sector; FK a sector; bucket sin mapear queda NULL', () => inRollback(async (c) => {
  const e = await etf(c);
  const tech = await sector(c);
  await c.query(A, [e, 'sector', 'Technology', tech, 31.2, 'provider']);
  await c.query(A, [e, 'sector', 'Consumer Cyclicals', null, 10.3, 'provider']); // sin mapeo: SECTOR_UNMAPPED lo emite el escritor
  for (const dim of ['region', 'market_cap', 'asset_class']) {
    expect((await dbError(c, A, [e, dim, 'United States', tech, 99, 'provider']))?.message, dim).toContain('etf_allocation_sector_only_for_sector');
  }
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
