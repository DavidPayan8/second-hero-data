import type pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const id = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
const security = async (c: pg.PoolClient) => {
  const co = await id(c, "INSERT INTO company (identity_source) VALUES ('isolated') RETURNING company_id AS id");
  return id(c, "INSERT INTO security (company_id, asset_type_id) VALUES ($1, (SELECT asset_type_id FROM asset_type WHERE code='common_stock')) RETURNING security_id AS id", [co]);
};

test('existen las 5 tablas de ownership', async () => {
  const names = ['holder_position', 'insider_transaction', 'ownership_snapshot', 'analyst_consensus', 'short_interest'];
  const { rows } = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY 1", [names]);
  expect(rows.map((r) => r.table_name)).toEqual([...names].sort());
});

const HP = "INSERT INTO holder_position (security_id, holder_ref, holder_name, holder_type, as_of_date, shares_held) VALUES ($1,$2,$3,$4,$5,1000)";

test('holder_position: clave (security, COALESCE(holder_ref, holder_name), as_of_date)', () => inRollback(async (c) => {
  const s = await security(c);
  await c.query(HP, [s, '0001067983', 'BlackRock Inc', 'institution', '2026-06-30']);
  // mismo holder_ref con otro nombre el mismo día: la serie no se parte -> error
  expect((await dbError(c, HP, [s, '0001067983', 'BlackRock, Inc.', 'institution', '2026-06-30']))?.code).toBe('23505');
  await c.query(HP, [s, '0001067983', 'BlackRock Inc', 'institution', '2026-09-30']); // otra fecha
  // sin holder_ref: el nombre es la identidad
  await c.query(HP, [s, null, 'Vanguard Group Inc', 'institution', '2026-06-30']);
  expect((await dbError(c, HP, [s, null, 'Vanguard Group Inc', 'institution', '2026-06-30']))?.code).toBe('23505');
  await c.query(HP, [s, null, 'Vanguard Group Inc', 'fund', '2026-09-30']);
  const s2 = await security(c);
  await c.query(HP, [s2, null, 'Vanguard Group Inc', 'institution', '2026-06-30']); // otra security
}));

test('holder_position: holder_type en dominio, campos obligatorios y FK', () => inRollback(async (c) => {
  const s = await security(c);
  expect((await dbError(c, HP, [s, null, 'X', 'etf', '2026-06-30']))?.code).toBe('23514');
  expect((await dbError(c, HP, [s, null, null, 'fund', '2026-06-30']))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO holder_position (security_id, holder_name, holder_type, as_of_date) VALUES ($1,'X','fund','2026-06-30')", [s]))?.code).toBe('23502'); // sin shares_held
  expect((await dbError(c, HP, [999999, null, 'X', 'fund', '2026-06-30']))?.code).toBe('23503');
  await c.query("INSERT INTO holder_position (security_id, holder_name, holder_type, as_of_date, shares_held, portfolio_weight_pct) VALUES ($1,'Y','fund','2026-06-30',1346616669.5,5.6185)", [s]);
  expect((await c.query('SELECT ingested_at IS NOT NULL AS ok FROM holder_position')).rows[0].ok).toBe(true);
}));

const IT = "INSERT INTO insider_transaction (security_id, provider_txn_id, insider_name, transaction_date, transaction_code, shares_transacted) VALUES ($1,$2,$3,$4,$5,$6)";

test('insider_transaction: dedup por provider_txn_id cuando existe', () => inRollback(async (c) => {
  const s = await security(c);
  await c.query(IT, [s, '0001140361-26-023363#0', 'LEVINSON ARTHUR D', '2026-05-27', 'S', 50000]);
  expect((await dbError(c, IT, [s, '0001140361-26-023363#0', 'OTRO NOMBRE', '2026-05-28', 'P', 1]))?.code).toBe('23505');
  // dos transacciones idénticas con ids distintos coexisten
  await c.query(IT, [s, 'id-a', 'LEVINSON ARTHUR D', '2026-05-27', 'S', 50000]);
  await c.query(IT, [s, 'id-b', 'LEVINSON ARTHUR D', '2026-05-27', 'S', 50000]);
  const s2 = await security(c);
  await c.query(IT, [s2, 'id-a', 'LEVINSON ARTHUR D', '2026-05-27', 'S', 50000]); // otra security
}));

test('insider_transaction: fallback de dedup sin provider_txn_id', () => inRollback(async (c) => {
  const s = await security(c);
  await c.query(IT, [s, null, 'COOK TIMOTHY D', '2026-04-01', 'S', 1000]);
  expect((await dbError(c, IT, [s, null, 'COOK TIMOTHY D', '2026-04-01', 'S', 1000]))?.code).toBe('23505');
  await c.query(IT, [s, null, 'COOK TIMOTHY D', '2026-04-02', 'S', 1000]); // otra fecha
  await c.query(IT, [s, null, 'COOK TIMOTHY D', '2026-04-01', 'P', 1000]); // otro código
  await c.query(IT, [s, null, 'COOK TIMOTHY D', '2026-04-01', 'S', 1001]); // otra cantidad
  await c.query(IT, [s, null, 'OTRO INSIDER', '2026-04-01', 'S', 1000]); // otro insider
  await c.query(IT, [s, 'x1', 'COOK TIMOTHY D', '2026-04-01', 'S', 1000]); // con id no choca con la clave fallback
}));

test('insider_transaction: obligatorios, vocabulario del proveedor sin CHECK, cantidades numeric', () => inRollback(async (c) => {
  const s = await security(c);
  expect((await dbError(c, IT, [s, null, null, '2026-04-01', 'S', 1]))?.code).toBe('23502'); // sin insider_name
  expect((await dbError(c, IT, [s, null, 'X', null, 'S', 1]))?.code).toBe('23502');
  expect((await dbError(c, IT, [s, null, 'X', '2026-04-01', null, 1]))?.code).toBe('23502');
  expect((await dbError(c, IT, [s, null, 'X', '2026-04-01', 'S', null]))?.code).toBe('23502');
  expect((await dbError(c, IT, [999999, null, 'X', '2026-04-01', 'S', 1]))?.code).toBe('23503');
  await c.query(IT, [s, null, 'X', '2026-04-01', 'CódigoNuevo', 0.5]); // código desconocido y cantidad fraccionaria: no tumban la ingesta
  await c.query("INSERT INTO insider_transaction (security_id, insider_name, transaction_date, transaction_code, shares_transacted, price_per_share, shares_owned_after, relationship) VALUES ($1,'Y','2026-04-01','A',10,NULL,NULL,NULL)", [s]);
}));

test('ownership_snapshot: PK (security, as_of_date) y porcentajes nullable', () => inRollback(async (c) => {
  const s = await security(c);
  await c.query("INSERT INTO ownership_snapshot (security_id, as_of_date) VALUES ($1,'2026-10-01')", [s]);
  expect((await dbError(c, "INSERT INTO ownership_snapshot (security_id, as_of_date, shares_float) VALUES ($1,'2026-10-01',1)", [s]))?.code).toBe('23505');
  await c.query("INSERT INTO ownership_snapshot (security_id, as_of_date, shares_float, percent_insiders, percent_institutions) VALUES ($1,'2026-10-02',15091184209,2.066,62.25)", [s]);
  expect((await dbError(c, "INSERT INTO ownership_snapshot (security_id) VALUES ($1)", [s]))?.code).toBe('23502');
}));

test('analyst_consensus: PK, estimación con divisa y rating_mean sin interpretar', () => inRollback(async (c) => {
  const s = await security(c);
  await c.query("INSERT INTO analyst_consensus (security_id, as_of_date, rating_mean, num_analysts, target_mean, target_low, target_high, target_currency) VALUES ($1,'2026-10-01',4.1064,47,247.925,200,300,'USD')", [s]);
  expect((await dbError(c, "INSERT INTO analyst_consensus (security_id, as_of_date) VALUES ($1,'2026-10-01')", [s]))?.code).toBe('23505');
  // precio objetivo sin divisa -> error; sin precios objetivo, nullable
  for (const col of ['target_mean', 'target_low', 'target_high']) {
    expect((await dbError(c, `INSERT INTO analyst_consensus (security_id, as_of_date, ${col}) VALUES ($1,'2026-10-02',10)`, [s]))?.message, col).toContain('analyst_consensus_target_has_currency');
  }
  await c.query("INSERT INTO analyst_consensus (security_id, as_of_date, rating_mean) VALUES ($1,'2026-10-03',2.3)", [s]);
  await c.query("INSERT INTO analyst_consensus (security_id, as_of_date, rating_mean) VALUES ($1,'2026-10-04',9.9)", [s]); // sin CHECK de rango: la escala no está verificada
}));

test('short_interest: PK (security, settlement_date), shares_short obligatorio, prior_month nullable', () => inRollback(async (c) => {
  const s = await security(c);
  await c.query("INSERT INTO short_interest (security_id, settlement_date, shares_short) VALUES ($1,'2026-09-15',157008120)", [s]);
  expect((await dbError(c, "INSERT INTO short_interest (security_id, settlement_date, shares_short) VALUES ($1,'2026-09-15',1)", [s]))?.code).toBe('23505');
  await c.query("INSERT INTO short_interest (security_id, settlement_date, shares_short, shares_short_prior_month) VALUES ($1,'2026-09-30',157008120,156458273)", [s]);
  expect((await dbError(c, "INSERT INTO short_interest (security_id, settlement_date) VALUES ($1,'2026-10-15')", [s]))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO short_interest (security_id, settlement_date, shares_short) VALUES (999999,'2026-10-15',1)"))?.code).toBe('23503');
}));

test('todas las cantidades de ownership son numeric', async () => {
  const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND
     (table_name, column_name) IN (('holder_position','shares_held'),('insider_transaction','shares_transacted'),('insider_transaction','shares_owned_after'),
     ('ownership_snapshot','shares_float'),('analyst_consensus','num_analysts'),('short_interest','shares_short'),('short_interest','shares_short_prior_month'))`,
  );
  expect(rows.length).toBe(7);
  expect(new Set(rows.map((r) => r.data_type))).toEqual(new Set(['numeric']));
});
