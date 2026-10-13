import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { buildJobs } from '../src/eodhd/jobs.js';
import { keepPrimaryListings } from '../src/eodhd/universe.js';

async function cleanAll() {
  for (const sql of ['DELETE FROM listing', 'DELETE FROM security', "DELETE FROM dimension_audit WHERE table_name IN ('security', 'listing')"]) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(cleanAll);

async function listing(symbol: string, security: string, primary: boolean) {
  await pool.query("INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency, status, is_primary_listing) VALUES ($1, $2, $3, 'USD', 'active', $4)", [security, symbol.split('.')[0], symbol, primary]);
}

test('div y splits solo se piden del listing primario; el resto de endpoints no se filtra', async () => {
  const sec = (await pool.query<{ id: string }>("INSERT INTO security (company_id, asset_type_id) VALUES (NULL, (SELECT asset_type_id FROM asset_type WHERE code = 'etf')) RETURNING security_id AS id")).rows[0]!.id;
  await listing('AAA.US', sec, true);
  await listing('0AAA.LSE', sec, false);
  const symbols = ['AAA.US', '0AAA.LSE', 'NOPE.US'];
  const div = await keepPrimaryListings(buildJobs('div:test', symbols));
  expect(div.jobs.map((j) => j.symbol)).toEqual(['AAA.US']);
  expect(div.skipped).toEqual([
    { symbol: '0AAA.LSE', endpoint: 'div/{symbol}', reason: 'no es el listing primario' },
    { symbol: 'NOPE.US', endpoint: 'div/{symbol}', reason: 'sin listing' },
  ]);
  const spl = await keepPrimaryListings(buildJobs('splits:test', symbols));
  expect(spl.jobs.map((j) => j.symbol)).toEqual(['AAA.US']);
  const eod = await keepPrimaryListings(buildJobs('eod:test', symbols));
  expect(eod.jobs.map((j) => j.symbol)).toEqual(symbols);
  expect(eod.skipped).toEqual([]);
});
