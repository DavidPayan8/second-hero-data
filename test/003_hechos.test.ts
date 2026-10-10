import type pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const id = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
const company = (c: pg.PoolClient) => id(c, "INSERT INTO company (identity_source) VALUES ('isolated') RETURNING company_id AS id");
const security = (c: pg.PoolClient, co: string | null = null) =>
  id(c, "INSERT INTO security (company_id, asset_type_id) VALUES ($1, (SELECT asset_type_id FROM asset_type WHERE code='common_stock')) RETURNING security_id AS id", [co]);
const listing = (c: pg.PoolClient, sec: string, sym = 'T.US') =>
  id(c, "INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency, status) VALUES ($1,'T',$2,'USD','active') RETURNING listing_id AS id", [sec, sym]);
const columns = async (table: string) =>
  (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table])).rows.map((r) => r.column_name);

test('existen las 7 tablas de hechos', async () => {
  const names = ['fundamentals', 'shares_outstanding', 'prices_daily', 'fx_rates', 'stock_split', 'dividend', 'earnings'];
  const { rows } = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY 1", [names]);
  expect(rows.map((r) => r.table_name)).toEqual([...names].sort());
});

const FUND = "INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, currency) VALUES ($1,'2025-12-31','Q',$2,'USD')";

test('A7: restatement (distinto reported_at) ok; mismo reported_at -> error', () => inRollback(async (c) => {
  const co = await company(c);
  await c.query(FUND, [co, '2026-01-30']);
  await c.query(FUND, [co, '2026-03-15']); // restatement
  expect((await dbError(c, FUND, [co, '2026-01-30']))?.code).toBe('23505');
  await c.query("INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, currency) VALUES ($1,'2025-12-31','A','2026-01-30','USD')", [co]); // otro period_type
}));

test('A8: reported_at_source por defecto estimated; fuera de dominio -> error', () => inRollback(async (c) => {
  const co = await company(c);
  await c.query(FUND, [co, '2026-01-30']);
  const { rows } = await c.query('SELECT reported_at_source, cross_checked_at FROM fundamentals');
  expect(rows[0]).toEqual({ reported_at_source: 'estimated', cross_checked_at: null });
  for (const ok of ['provider', 'provider_derived', 'estimated', 'manual', 'cross_checked']) {
    await c.query("INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, reported_at_source, currency) VALUES ($1,'2024-12-31','Q',$2,$3,'USD')", [co, `2025-0${ok.length % 9 + 1}-01`, ok]);
  }
  expect((await dbError(c, "INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, reported_at_source, currency) VALUES ($1,'2023-12-31','Q','2024-01-30','unknown','USD')", [co]))?.code).toBe('23514');
}));

test('fundamentals: period_type Q|A, currency y fechas obligatorias, líneas nullable', () => inRollback(async (c) => {
  const co = await company(c);
  expect((await dbError(c, "INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, currency) VALUES ($1,'2025-12-31','X','2026-01-30','USD')", [co]))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO fundamentals (company_id, period_end, period_type, reported_at) VALUES ($1,'2025-12-31','Q','2026-01-30')", [co]))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO fundamentals (company_id, period_end, period_type, currency) VALUES ($1,'2025-12-31','Q','USD')", [co]))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, currency) VALUES (999999,'2025-12-31','Q','2026-01-30','USD')"))?.code).toBe('23503');
  await c.query(FUND, [co, '2026-01-30']); // solo con lo obligatorio: todas las líneas NULL
  const { rows } = await c.query('SELECT revenue, net_income, total_assets FROM fundamentals');
  expect(rows[0]).toEqual({ revenue: null, net_income: null, total_assets: null });
}));

test('fundamentals: importes numeric sin pérdida', () => inRollback(async (c) => {
  const co = await company(c);
  await c.query("INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, currency, revenue) VALUES ($1,'2025-12-31','Q','2026-01-30','USD',394328000000.123456)", [co]);
  expect((await c.query('SELECT revenue::text AS r FROM fundamentals')).rows[0].r).toBe('394328000000.123456');
}));

test('shares_outstanding: mismo patrón bitemporal y shares obligatorio', () => inRollback(async (c) => {
  const s = await security(c, await company(c));
  const SH = "INSERT INTO shares_outstanding (security_id, period_end, reported_at, shares) VALUES ($1,'2025-12-31',$2,15700000000)";
  await c.query(SH, [s, '2026-01-30']);
  await c.query(SH, [s, '2026-03-15']);
  expect((await dbError(c, SH, [s, '2026-01-30']))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO shares_outstanding (security_id, period_end, reported_at) VALUES ($1,'2025-12-31','2026-02-01')", [s]))?.code).toBe('23502');
  expect((await c.query('SELECT reported_at_source FROM shares_outstanding LIMIT 1')).rows[0].reported_at_source).toBe('estimated');
  expect((await dbError(c, "INSERT INTO shares_outstanding (security_id, period_end, reported_at, reported_at_source, shares) VALUES ($1,'2025-09-30','2026-02-01','x',1)", [s]))?.code).toBe('23514');
}));

test('prices_daily: PK (listing, date), close obligatorio y SIN columnas ajustadas', () => inRollback(async (c) => {
  const l = await listing(c, await security(c, await company(c)));
  const P = "INSERT INTO prices_daily (listing_id, date, open, high, low, close, volume) VALUES ($1,'2026-10-09',1,2,0.5,1.5,1000)";
  await c.query(P, [l]);
  expect((await dbError(c, P, [l]))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO prices_daily (listing_id, date, open) VALUES ($1,'2026-10-08',1)", [l]))?.code).toBe('23502');
  await c.query("INSERT INTO prices_daily (listing_id, date, close) VALUES ($1,'2026-10-07',3793.5)", [l]); // open/high/low/volume nullable
  expect((await dbError(c, "INSERT INTO prices_daily (listing_id, date, close) VALUES (999999,'2026-10-07',1)"))?.code).toBe('23503');
  expect(await columns('prices_daily')).not.toContain('adjusted_close');
  expect((await columns('prices_daily')).sort()).toEqual(['close', 'date', 'high', 'listing_id', 'low', 'open', 'volume']);
}));

test('fx_rates: PK (currency, date), tipo positivo, GBX como fila propia', () => inRollback(async (c) => {
  await c.query("INSERT INTO fx_rates (currency, date, rate_to_base) VALUES ('USD','2026-10-09',0.8593), ('GBX','2026-10-09',0.0115)");
  expect((await dbError(c, "INSERT INTO fx_rates (currency, date, rate_to_base) VALUES ('USD','2026-10-09',0.9)"))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO fx_rates (currency, date, rate_to_base) VALUES ('EUR','2026-10-09',0)"))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO fx_rates (currency, date, rate_to_base) VALUES ('EUR','2026-10-09',-1)"))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO fx_rates (currency, date) VALUES ('EUR','2026-10-09')"))?.code).toBe('23502');
}));

test('stock_split: UNIQUE (security, ex_date), numerador y denominador > 0 y no enteros permitidos', () => inRollback(async (c) => {
  const s = await security(c, await company(c));
  const SP = "INSERT INTO stock_split (security_id, ex_date, split_numerator, split_denominator) VALUES ($1,$2,$3,$4)";
  await c.query(SP, [s, '2020-08-31', 4, 1]);
  expect((await dbError(c, SP, [s, '2020-08-31', 4, 1]))?.code).toBe('23505'); // reescritura idempotente
  await c.query(SP, [s, '2014-06-09', 7, 1]);
  await c.query(SP, [s, '2010-01-01', 1748175, 1000000]); // reorganización no entera
  expect((await dbError(c, SP, [s, '2000-01-01', 0, 1]))?.code).toBe('23514');
  expect((await dbError(c, SP, [s, '2000-01-02', 2, 0]))?.code).toBe('23514');
  const s2 = await security(c, await company(c));
  await c.query(SP, [s2, '2020-08-31', 4, 1]); // otra security, misma fecha
}));

test('dividend: amount_native y currency obligatorios, period libre, sin UNIQUE, sin columna ajustada', () => inRollback(async (c) => {
  const s = await security(c, await company(c));
  const D = "INSERT INTO dividend (security_id, ex_date, period, amount_native, currency) VALUES ($1,'2026-08-10',$2,0.27,'USD')";
  await c.query(D, [s, 'Quarterly']);
  await c.query(D, [s, 'Etiqueta nueva del proveedor']); // vocabulario del proveedor: sin CHECK
  await c.query("INSERT INTO dividend (security_id, ex_date, amount_native, currency) VALUES ($1,'2026-08-10',0.1,'USD')", [s]); // period NULL; mismo ex_date: P5 abierta
  expect((await dbError(c, "INSERT INTO dividend (security_id, ex_date, currency) VALUES ($1,'2026-08-11','USD')", [s]))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO dividend (security_id, ex_date, amount_native) VALUES ($1,'2026-08-11',0.1)", [s]))?.code).toBe('23502');
  await c.query("INSERT INTO dividend (security_id, ex_date, amount_native, currency) VALUES ($1,'2026-11-09',0.2725,'GBP')", [s]);
  const cols = await columns('dividend');
  expect(cols).not.toContain('value');
  expect(cols).not.toContain('adjusted_value');
  expect(cols).toContain('amount_native');
}));

test('earnings: PK natural, report_time en dominio con default unknown, estimación con divisa', () => inRollback(async (c) => {
  const s = await security(c, await company(c));
  const E = "INSERT INTO earnings (security_id, fiscal_period_end, period_type) VALUES ($1,'2026-09-30','Q')";
  await c.query(E, [s]);
  expect((await dbError(c, E, [s]))?.code).toBe('23505'); // UPSERT por la PK
  const { rows } = await c.query('SELECT report_time, is_reported, report_date, eps_estimate FROM earnings');
  expect(rows[0]).toEqual({ report_time: 'unknown', is_reported: false, report_date: null, eps_estimate: null });
  await c.query("INSERT INTO earnings (security_id, fiscal_period_end, period_type) VALUES ($1,'2026-09-30','A')", [s]); // otro period_type
  expect((await dbError(c, "INSERT INTO earnings (security_id, fiscal_period_end, period_type, report_time) VALUES ($1,'2026-06-30','Q','premarket')", [s]))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO earnings (security_id, fiscal_period_end, period_type) VALUES ($1,'2026-06-30','Z')", [s]))?.code).toBe('23514');
  for (const t of ['before_market', 'after_market']) {
    await c.query("INSERT INTO earnings (security_id, fiscal_period_end, period_type, report_time) VALUES ($1,$2,'Q',$3)", [s, t === 'before_market' ? '2026-03-31' : '2026-12-31', t]);
  }
  // estimación sin divisa -> error; con divisa, o sin estimación, ok
  expect((await dbError(c, "INSERT INTO earnings (security_id, fiscal_period_end, period_type, eps_estimate) VALUES ($1,'2025-09-30','Q',1.98)", [s]))?.message).toContain('earnings_estimate_has_currency');
  expect((await dbError(c, "INSERT INTO earnings (security_id, fiscal_period_end, period_type, revenue_estimate) VALUES ($1,'2025-09-30','Q',1000)", [s]))?.message).toContain('earnings_estimate_has_currency');
  await c.query("INSERT INTO earnings (security_id, fiscal_period_end, period_type, eps_estimate, estimate_currency) VALUES ($1,'2025-09-30','Q',1.98,'USD')", [s]);
  expect(await columns('earnings')).not.toContain('eps_actual');
}));
