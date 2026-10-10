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
const HP = "INSERT INTO holder_position (security_id, holder_name, holder_type, as_of_date, shares_held) VALUES ($1,$2,'institution','2026-06-30',1)";

test('holder_name_norm colapsa espacios internos además de trim, mayúsculas y puntuación', async () => {
  const norm = async (x: string) => (await pool.query<{ n: string }>('SELECT holder_name_norm($1) AS n', [x])).rows[0]!.n;
  expect(await norm('Black  Rock')).toBe('BLACK ROCK');
  expect(await norm('Black\t \n Rock')).toBe('BLACK ROCK');
  expect(await norm('  BlackRock ,  Inc. ')).toBe('BLACKROCK INC');
  expect(await norm('Black Rock')).toBe('BLACK ROCK');
  // no unifica significado: Inc y Incorporated siguen siendo distintos
  expect(await norm('Vanguard Group Inc')).not.toBe(await norm('Vanguard Group Incorporated'));
});

test('"Black  Rock" (dos espacios) choca con "Black Rock" el mismo día', () => inRollback(async (c) => {
  const s = await security(c);
  await c.query(HP, [s, 'Black Rock']);
  expect((await dbError(c, HP, [s, 'Black  Rock']))?.code).toBe('23505');
  expect((await dbError(c, HP, [s, ' black\trock. ']))?.code).toBe('23505');
  await c.query(HP, [s, 'Black Rock Incorporated']); // sufijos distintos: no se fusionan
}));

test('la función sigue siendo IMMUTABLE y el índice está válido tras el REINDEX', async () => {
  const fn = (await pool.query("SELECT provolatile FROM pg_proc WHERE proname='holder_name_norm'")).rows;
  expect(fn).toEqual([{ provolatile: 'i' }]); // una sola función, sin sobrecargas duplicadas
  const idx = (await pool.query("SELECT indisvalid, indisunique FROM pg_index WHERE indexrelid='holder_position_key_idx'::regclass")).rows[0];
  expect(idx).toEqual({ indisvalid: true, indisunique: true });
});
