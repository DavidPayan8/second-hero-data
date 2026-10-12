import type pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const id = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
const etf = (c: pg.PoolClient) =>
  id(c, "INSERT INTO security (company_id, asset_type_id) VALUES (NULL, (SELECT asset_type_id FROM asset_type WHERE code='etf')) RETURNING security_id AS id");
const H = "INSERT INTO etf_holding (security_id, as_of_date, constituent_symbol, constituent_isin, constituent_name, weight_pct) VALUES ($1,'2026-10-01',$2,$3,$4,1)";

test('un constituyente solo con símbolo X y otro solo con nombre X el mismo día no chocan', () => inRollback(async (c) => {
  const e = await etf(c);
  await c.query(H, [e, 'X', null, null]); // solo símbolo
  await c.query(H, [e, null, null, 'X']); // solo nombre
  await c.query(H, [e, null, 'X', null]); // solo isin
  const { rows } = await c.query('SELECT count(*)::int AS n FROM etf_holding WHERE security_id=$1', [e]);
  expect(rows[0].n).toBe(3);
}));

test('el mismo identificador del mismo tipo sigue chocando', () => inRollback(async (c) => {
  const e = await etf(c);
  await c.query(H, [e, 'AAPL.US', null, null]);
  expect((await dbError(c, H, [e, 'AAPL.US', 'US0378331005', 'Apple Inc']))?.code).toBe('23505'); // el símbolo manda
  await c.query(H, [e, null, 'US0378331005', null]);
  expect((await dbError(c, H, [e, null, 'US0378331005', 'Apple Inc']))?.code).toBe('23505');
  await c.query(H, [e, null, null, 'Bono 2031']);
  expect((await dbError(c, H, [e, null, null, 'Bono 2031']))?.code).toBe('23505');
}));

test('la clave sigue siendo por ETF y por fecha, y usa solo identificadores del proveedor', () => inRollback(async (c) => {
  const e = await etf(c);
  const aapl = await etf(c);
  await c.query(H, [e, 'AAPL.US', null, null]);
  await c.query(H.replace("'2026-10-01'", "'2026-11-01'"), [e, 'AAPL.US', null, null]); // otra fecha
  await c.query(H, [await etf(c), 'AAPL.US', null, null]); // otro ETF
  // resolver el constituyente después no cambia la clave
  expect((await dbError(c, "INSERT INTO etf_holding (security_id, as_of_date, constituent_security_id, constituent_symbol, weight_pct) VALUES ($1,'2026-10-01',$2,'AAPL.US',1)", [e, aapl]))?.code).toBe('23505');
  // y sin identificador del proveedor sigue sin valer (constituent_security_id solo no basta)
  expect((await dbError(c, "INSERT INTO etf_holding (security_id, as_of_date, constituent_security_id, weight_pct) VALUES ($1,'2026-10-01',$2,1)", [e, aapl]))?.message).toContain('etf_holding_has_constituent');
}));

test('la definición del índice lleva los prefijos sym:, isin: y name:', async () => {
  const { rows } = await pool.query<{ def: string }>("SELECT pg_get_indexdef('etf_holding_key_idx'::regclass) AS def");
  expect(rows[0]!.def).toContain("'sym:'");
  expect(rows[0]!.def).toContain("'isin:'");
  expect(rows[0]!.def).toContain("'name:'");
  const n = await pool.query("SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='etf_holding' AND indexname='etf_holding_key_idx'");
  expect(n.rows[0].n).toBe(1);
});
