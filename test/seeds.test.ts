import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

test('asset_type: common_stock y etf con sus flags', async () => {
  const { rows } = await pool.query("SELECT code, in_screener_scope, requires_company FROM asset_type ORDER BY code");
  expect(rows).toEqual([
    { code: 'common_stock', in_screener_scope: true, requires_company: true },
    { code: 'etf', in_screener_scope: true, requires_company: false },
  ]);
});

test('exchange: están los MIC del mapa de sub-bolsas de EEUU y las bolsas clave', async () => {
  const { rows } = await pool.query<{ mic: string }>('SELECT mic FROM exchange');
  const mics = new Set(rows.map((r) => r.mic));
  for (const m of ['XNAS', 'XNYS', 'ARCX', 'XASE', 'BATS', 'OTCM', 'XTSE', 'XLON', 'XETR', 'XMAD']) expect(mics.has(m), m).toBe(true);
});

test('exchange: timezone existe en pg_timezone_names (datos reales del seed)', async () => {
  const bad = await pool.query("SELECT mic FROM exchange WHERE timezone NOT IN (SELECT name FROM pg_timezone_names)");
  expect(bad.rows).toEqual([]);
  const n = await pool.query<{ n: string }>('SELECT count(*) AS n FROM exchange');
  expect(Number(n.rows[0]!.n)).toBeGreaterThan(20);
});

test('los seeds son idempotentes', async () => {
  const count = async () => Number((await pool.query<{ n: string }>('SELECT (SELECT count(*) FROM exchange) + (SELECT count(*) FROM asset_type) AS n')).rows[0]!.n);
  const before = await count();
  await seed();
  expect(await count()).toBe(before);
});
