import type pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const id = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
const company = (c: pg.PoolClient, cols = 'legal_name, identity_source', vals = "'Acme', 'isolated'") =>
  id(c, `INSERT INTO company (${cols}) VALUES (${vals}) RETURNING company_id AS id`);
const security = (c: pg.PoolClient, companyId: string | null, isin: string | null) =>
  id(c, "INSERT INTO security (company_id, asset_type_id, isin) VALUES ($1, (SELECT asset_type_id FROM asset_type WHERE code='common_stock'), $2) RETURNING security_id AS id", [companyId, isin]);
const LISTING = "INSERT INTO listing (security_id, exchange_id, ticker, provider_symbol, quote_currency, is_primary_listing) VALUES ($1, (SELECT exchange_id FROM exchange WHERE mic='XNAS'), $2, $3, 'USD', $4)";

test('existen las 4 tablas de identidad', async () => {
  const { rows } = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY 1",
    [['company', 'security', 'listing', 'listing_ticker_change']],
  );
  expect(rows.map((r) => r.table_name)).toEqual(['company', 'listing', 'listing_ticker_change', 'security']);
});

test('company: cik y lei únicos, varios NULL permitidos', () => inRollback(async (c) => {
  await company(c, 'legal_name, identity_source, cik', "'A','cik','111'");
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source, cik) VALUES ('B','cik','111')"))?.code).toBe('23505');
  await company(c, 'legal_name, identity_source, lei', "'C','lei','L1'");
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source, lei) VALUES ('D','lei','L1')"))?.code).toBe('23505');
  await company(c); await company(c); // dos isolated sin cik/lei
}));

test('company: identity_source en dominio y con su evidencia', () => inRollback(async (c) => {
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source) VALUES ('X','nombre')"))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO company (legal_name) VALUES ('X')"))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source) VALUES ('X','cik')"))?.message).toContain('company_identity_source_has_id');
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source) VALUES ('X','lei')"))?.message).toContain('company_identity_source_has_id');
  expect((await dbError(c, "INSERT INTO company (identity_source) VALUES ('isolated')"))?.code).toBe('23502');
}));

test('company: country_iso alfa-2, mes fiscal 1-12, FK de sector e industria', () => inRollback(async (c) => {
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source, country_iso) VALUES ('X','isolated','USA')"))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source, fiscal_year_end_month) VALUES ('X','isolated',13)"))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source, fiscal_year_end_month) VALUES ('X','isolated',0)"))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source, sector_id) VALUES ('X','isolated',999999)"))?.code).toBe('23503');
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source, industry_id) VALUES ('X','isolated',999999)"))?.code).toBe('23503');
  await company(c, 'legal_name, identity_source, country_iso, fiscal_year_end_month', "'Ok','isolated','US',9");
}));

test('security: isin único, varios NULL, company_id nullable y FK de asset_type', () => inRollback(async (c) => {
  const co = await company(c);
  await security(c, co, 'US0378331005');
  expect((await dbError(c, "INSERT INTO security (company_id, asset_type_id, isin) VALUES ($1, (SELECT asset_type_id FROM asset_type LIMIT 1), 'US0378331005')", [co]))?.code).toBe('23505');
  await security(c, co, null); await security(c, null, null);
  expect((await dbError(c, 'INSERT INTO security (company_id, asset_type_id) VALUES ($1, 999999)', [co]))?.code).toBe('23503');
  expect((await dbError(c, 'INSERT INTO security (company_id) VALUES ($1)', [co]))?.code).toBe('23502');
  expect((await dbError(c, 'INSERT INTO security (company_id, asset_type_id) VALUES (999999, (SELECT asset_type_id FROM asset_type LIMIT 1))'))?.code).toBe('23503');
}));

test('listing: provider_symbol único y campos obligatorios', () => inRollback(async (c) => {
  const s = await security(c, await company(c), 'US1');
  await c.query(LISTING, [s, 'AAPL', 'AAPL.US', true]);
  expect((await dbError(c, LISTING, [s, 'AAPL', 'AAPL.US', false]))?.code).toBe('23505');
  expect((await dbError(c, "INSERT INTO listing (security_id, ticker, provider_symbol) VALUES ($1,'X','X.US')", [s]))?.code).toBe('23502'); // sin quote_currency
  expect((await dbError(c, "INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency) VALUES (999999,'X','X.US','USD')"))?.code).toBe('23503');
  expect((await dbError(c, "INSERT INTO listing (security_id, exchange_id, ticker, provider_symbol, quote_currency) VALUES ($1, 999999,'X','X.US','USD')", [s]))?.code).toBe('23503');
  const { rows } = await c.query("SELECT is_primary_listing FROM listing WHERE provider_symbol='AAPL.US'");
  expect(rows[0].is_primary_listing).toBe(true);
}));

test('A6: dos listings primarios para la misma security -> error; no primarios, sin límite', () => inRollback(async (c) => {
  const s = await security(c, await company(c), 'US2');
  await c.query(LISTING, [s, 'A', 'A.US', true]);
  expect((await dbError(c, LISTING, [s, 'A', 'A.XETRA', true]))?.code).toBe('23505');
  await c.query(LISTING, [s, 'A', 'A.XETRA', false]);
  await c.query(LISTING, [s, 'A', 'A.LSE', false]);
  const s2 = await security(c, await company(c), 'US3');
  await c.query(LISTING, [s2, 'B', 'B.US', true]); // otra security puede tener su primario
}));

test('listing_ticker_change: FK a listing y campos obligatorios', () => inRollback(async (c) => {
  const s = await security(c, await company(c), 'US4');
  await c.query(LISTING, [s, 'META', 'META.US', true]);
  const l = await id(c, "SELECT listing_id AS id FROM listing WHERE provider_symbol='META.US'");
  await c.query("INSERT INTO listing_ticker_change (listing_id, old_ticker, new_ticker, effective_date) VALUES ($1,'FB','META','2022-06-09')", [l]);
  expect((await dbError(c, "INSERT INTO listing_ticker_change (listing_id, old_ticker, new_ticker, effective_date) VALUES (999999,'FB','META','2022-06-09')"))?.code).toBe('23503');
  expect((await dbError(c, "INSERT INTO listing_ticker_change (listing_id, old_ticker, new_ticker) VALUES ($1,'FB','META')", [l]))?.code).toBe('23502');
}));

test('no se borra un registro referenciado', () => inRollback(async (c) => {
  const co = await company(c);
  const s = await security(c, co, 'US5');
  await c.query(LISTING, [s, 'X', 'X.US', true]);
  expect((await dbError(c, 'DELETE FROM security WHERE security_id=$1', [s]))?.code).toBe('23503');
  expect((await dbError(c, 'DELETE FROM company WHERE company_id=$1', [co]))?.code).toBe('23503');
}));
