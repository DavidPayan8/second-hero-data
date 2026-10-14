import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

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

test('taxonomía D3: 11 sectores y 38 industrias, repartidas como en el documento', async () => {
  const n = await pool.query<{ s: string; i: string }>('SELECT (SELECT count(*) FROM sector) AS s, (SELECT count(*) FROM industry) AS i');
  expect(n.rows[0]).toEqual({ s: '11', i: '38' });
  const per = await pool.query<{ code: string; n: string }>('SELECT s.code, count(*) AS n FROM industry i JOIN sector s USING (sector_id) GROUP BY s.code');
  expect(Object.fromEntries(per.rows.map((r) => [r.code, Number(r.n)]))).toEqual({
    energy: 3, materials: 4, industrials: 5, consumer_cyclical: 4, consumer_staples: 3, health_care: 3,
    financials: 4, real_estate: 2, technology: 4, communication: 3, utilities: 3,
  });
});

test('taxonomía D3: banking e insurance en financials, reits en real_estate', async () => {
  const { rows } = await pool.query<{ industry: string; sector: string }>(
    "SELECT i.code AS industry, s.code AS sector FROM industry i JOIN sector s USING (sector_id) WHERE i.code IN ('banking', 'insurance', 'reits') ORDER BY i.code");
  expect(rows).toEqual([
    { industry: 'banking', sector: 'financials' },
    { industry: 'insurance', sector: 'financials' },
    { industry: 'reits', sector: 'real_estate' },
  ]);
});

test('taxonomía D3: la FK compuesta de company acepta cada industria con su sector y rechaza otro sector', () => inRollback(async (c) => {
  const { rows } = await c.query<{ industry_id: string; sector_id: string }>('SELECT industry_id, sector_id FROM industry');
  expect(rows).toHaveLength(38);
  let n = 0;
  for (const r of rows) {
    n++;
    expect(await dbError(c, "INSERT INTO company (legal_name, identity_source, cik, sector_id, industry_id) VALUES ('D3', 'cik', $1, $2, $3)", [String(n), r.sector_id, r.industry_id])).toBeNull();
  }
  const bad = await c.query<{ industry_id: string; sector_id: string }>(
    "SELECT i.industry_id, s.sector_id FROM industry i, sector s WHERE i.code = 'banking' AND s.code = 'energy'");
  expect((await dbError(c, "INSERT INTO company (legal_name, identity_source, cik, sector_id, industry_id) VALUES ('D3 mal', 'cik', '999', $1, $2)", [bad.rows[0]!.sector_id, bad.rows[0]!.industry_id]))?.code).toBe('23503');
}));

test('taxonomía D3: relanzar el seed no cambia filas ni escribe en dimension_audit', async () => {
  const state = async () => (await pool.query<{ s: string; i: string; a: string }>(
    'SELECT (SELECT count(*) FROM sector) AS s, (SELECT count(*) FROM industry) AS i, (SELECT count(*) FROM dimension_audit) AS a')).rows[0];
  const before = await state();
  await seed();
  await seed();
  expect(await state()).toEqual(before);
});
