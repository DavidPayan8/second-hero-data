import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { replay } from '../src/eodhd/replay.js';

// Escritor de noticias: payloads con la forma real de `news` (date, title, content, link, symbols[], tags[], sentiment{...}).
async function cleanAll() {
  for (const sql of [
    'DELETE FROM news_security', 'DELETE FROM news', 'DELETE FROM listing', 'DELETE FROM security', 'DELETE FROM company',
    'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run',
    "DELETE FROM dimension_audit WHERE table_name IN ('company', 'security', 'listing')",
  ]) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(async () => { runId = ''; await cleanAll(); });

let runId = '';
async function news(symbol: string, body: unknown): Promise<string> {
  if (!runId) runId = (await pool.query<{ id: string }>("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd', 'test:news', 'ok', now()) RETURNING ingestion_run_id AS id")).rows[0]!.id;
  const bytes = Buffer.from(JSON.stringify(body));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query('INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [hash, bytes, bytes.length]);
  return (await pool.query<{ id: string }>(
    'INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash, fetched_at) VALUES ($1,$2,$3,$4::jsonb,200,$5,now()) RETURNING raw_payload_id AS id',
    [runId, 'news', symbol, JSON.stringify({ s: symbol, limit: '10' }), hash],
  )).rows[0]!.id;
}
async function makeStock(symbol: string, security?: string) {
  const sec = security ?? await (async () => {
    const company = (await pool.query<{ id: string }>("INSERT INTO company (legal_name, cik, identity_source) VALUES ($1, $2, 'cik') RETURNING company_id AS id", [`Empresa ${symbol}`, `cik-${symbol}`])).rows[0]!.id;
    return (await pool.query<{ id: string }>("INSERT INTO security (company_id, asset_type_id) VALUES ($1, (SELECT asset_type_id FROM asset_type WHERE code = 'common_stock')) RETURNING security_id AS id", [company])).rows[0]!.id;
  })();
  await pool.query("INSERT INTO listing (security_id, ticker, provider_symbol, quote_currency, status, is_primary_listing) VALUES ($1, $2, $3, 'USD', 'active', $4)", [sec, symbol.split('.')[0], symbol, !security]);
  return sec;
}
const art = (n: number, over: Record<string, unknown> = {}) => ({
  date: `2026-10-1${n}T14:40:00+00:00`, title: `Titular ${n}`, content: 'texto íntegro de un tercero', link: `https://ejemplo.test/n${n}`,
  symbols: ['AAA.US'], tags: ['TECH'], sentiment: { polarity: 0.402, neg: 0, neu: 0.87, pos: 0.13 }, ...over,
});
const stored = async () => (await pool.query(
  `SELECT url, published_at AS at, headline, symbols, tags, sentiment_polarity::text AS pol, sentiment_neg::text AS neg, sentiment_neu::text AS neu, sentiment_pos::text AS pos FROM news ORDER BY url`)).rows;
const links = async () => (await pool.query('SELECT news_id, security_id FROM news_security')).rows;

test('upsert por url: titular, fecha, tags, símbolos crudos y sentimiento; el contenido no se guarda; NEWS_SECURITY solo con los símbolos que resuelven', async () => {
  const sec = await makeStock('AAA.US');
  await makeStock('AAA.MX', sec); // otra cotización de la misma security: colapsa en una fila
  await makeStock('BBB.US');
  await news('AAA.US', [art(1, { symbols: ['AAA.US', 'AAA.MX', 'BBB.US', 'DJI.INDX', 'CL.COMM', 'OPAI.PVT'] })]);
  const out = await replay();
  expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
  expect(out.news).toMatchObject({ payloads: 1, articles: 1, inserted: 1, updated: 0, unchanged: 0, skippedIncomplete: 0, linksAdded: 2 });
  expect(await stored()).toEqual([{
    url: 'https://ejemplo.test/n1', at: new Date('2026-10-11T14:40:00Z'), headline: 'Titular 1', symbols: ['AAA.US', 'AAA.MX', 'BBB.US', 'DJI.INDX', 'CL.COMM', 'OPAI.PVT'],
    tags: ['TECH'], pol: '0.402', neg: '0', neu: '0.87', pos: '0.13',
  }]);
  // AAA.US y AAA.MX son la misma security (una fila) y BBB.US otra; DJI.INDX, CL.COMM y OPAI.PVT no resuelven y se ignoran
  expect((await pool.query('SELECT security_id::text AS s FROM news_security ORDER BY 1')).rows).toEqual([{ s: sec }, { s: String(Number(sec) + 1) }].sort((a, b) => Number(a.s) - Number(b.s)));
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'news'")).rows.map((r) => r.column_name);
  expect(cols).not.toContain('content');
});

test('idempotente; un refetch actualiza en silencio y los enlaces solo crecen', async () => {
  await makeStock('AAA.US');
  await makeStock('BBB.US');
  await news('AAA.US', [art(1), art(2)]);
  await replay();
  expect((await replay({ all: true })).news).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, linksAdded: 0 });
  // el proveedor corrige el titular y el sentimiento y añade un símbolo; otro payload (más reciente) del mismo ticker
  await news('AAA.US', [art(1, { title: 'Titular corregido', symbols: ['AAA.US', 'BBB.US'], sentiment: { polarity: 0.5, neg: 0.1, neu: 0.6, pos: 0.3 } }), art(2)]);
  const out = await replay({ all: true });
  expect(out.news).toMatchObject({ inserted: 0, updated: 1, unchanged: 1, linksAdded: 1 });
  expect((await stored())[0]).toMatchObject({ headline: 'Titular corregido', pol: '0.5', symbols: ['AAA.US', 'BBB.US'] });
  expect(await links()).toHaveLength(3);
  // un refetch con menos símbolos no borra enlaces
  await news('AAA.US', [art(1, { title: 'Titular corregido', symbols: ['AAA.US'], sentiment: { polarity: 0.5, neg: 0.1, neu: 0.6, pos: 0.3 } })]);
  await replay({ all: true });
  expect(await links()).toHaveLength(3);
  expect((await pool.query('SELECT count(*)::int AS n FROM data_quality_finding')).rows[0]!.n).toBe(0); // sin findings
});

test('sin url, titular o fecha válidos no se crea (sin finding); sin sentimiento queda NULL; la misma url dos veces en un payload es una fila', async () => {
  await makeStock('AAA.US');
  await news('AAA.US', [art(1), art(2, { link: null }), art(3, { title: '' }), art(4, { date: 'ayer' }), art(5, { sentiment: undefined, tags: undefined }), art(1, { title: 'Repetida' })]);
  const out = await replay();
  expect(out).toMatchObject({ checked: 1, ok: 1, error: 0 });
  expect(out.news).toMatchObject({ articles: 6, inserted: 2, skippedIncomplete: 3 });
  const rows = await stored();
  expect(rows.map((r) => r.url)).toEqual(['https://ejemplo.test/n1', 'https://ejemplo.test/n5']);
  expect(rows[0]).toMatchObject({ headline: 'Repetida' });
  expect(rows[1]).toMatchObject({ pol: null, neg: null, tags: null });
});

test('un cuerpo que no es una lista marca el payload como error', async () => {
  await makeStock('AAA.US');
  await news('AAA.US', { error: 'x' });
  const out = await replay();
  expect(out).toMatchObject({ checked: 1, ok: 0, error: 1 });
});
