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
const URL1 = 'https://finance.yahoo.com/technology/ai/articles/back-office-agent-wave-already-150242112.html';
const news = (c: pg.PoolClient, url = URL1, headline = 'Titular') =>
  id(c, "INSERT INTO news (url, published_at, headline) VALUES ($1, '2026-10-10T15:02:42+00:00', $2) RETURNING news_id AS id", [url, headline]);

test('columnas exactas del modelo: sin summary, publisher ni content', async () => {
  const cols = async (t: string) => (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t])).rows.map((r) => r.column_name);
  expect(await cols('news')).toEqual(['news_id', 'url', 'published_at', 'headline', 'symbols', 'tags', 'sentiment_polarity', 'sentiment_neg', 'sentiment_neu', 'sentiment_pos']);
  expect(await cols('news_security')).toEqual(['news_id', 'security_id']);
});

test('url, published_at y headline NOT NULL; url duplicada falla', () => inRollback(async (c) => {
  expect((await dbError(c, "INSERT INTO news (published_at, headline) VALUES (now(),'x')"))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO news (url, headline) VALUES ('u','x')"))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO news (url, published_at) VALUES ('u',now())"))?.code).toBe('23502');
  await news(c);
  expect((await dbError(c, "INSERT INTO news (url, published_at, headline) VALUES ($1, now(), 'otro')", [URL1]))?.code).toBe('23505');
  await news(c, URL1 + '?utm=1'); // url distinta, sin normalizar: son dos filas
  expect((await c.query('SELECT count(*)::int AS n FROM news')).rows[0].n).toBe(2);
}));

test('upsert por url actualiza headline, published_at, tags, symbols y sentiment sin duplicar', () => inRollback(async (c) => {
  const UP = `INSERT INTO news (url, published_at, headline, symbols, tags, sentiment_polarity, sentiment_neg, sentiment_neu, sentiment_pos)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
              ON CONFLICT (url) DO UPDATE SET published_at = EXCLUDED.published_at, headline = EXCLUDED.headline, symbols = EXCLUDED.symbols,
                tags = EXCLUDED.tags, sentiment_polarity = EXCLUDED.sentiment_polarity, sentiment_neg = EXCLUDED.sentiment_neg,
                sentiment_neu = EXCLUDED.sentiment_neu, sentiment_pos = EXCLUDED.sentiment_pos
              RETURNING news_id AS id`;
  const first = await id(c, UP, [URL1, '2026-10-10T15:02:42+00:00', 'Titular inicial', ['AAPL.US', 'SAP.US'], ['AI', 'EARNINGS'], 0.837, 0.024, 0.942, 0.034]);
  const second = await id(c, UP, [URL1, '2026-10-10T16:00:00+00:00', 'Titular corregido', ['AAPL.US', 'SAP.US', 'WDAY.US'], ['AI'], 0.5, 0.1, 0.8, 0.1]);
  expect(second).toBe(first); // misma fila
  const { rows } = await c.query('SELECT headline, symbols, tags, sentiment_polarity::text AS pol, published_at::text AS p FROM news');
  expect(rows).toHaveLength(1);
  expect(rows[0].headline).toBe('Titular corregido');
  expect(rows[0].symbols).toEqual(['AAPL.US', 'SAP.US', 'WDAY.US']);
  expect(rows[0].tags).toEqual(['AI']);
  expect(rows[0].pol).toBe('0.5');
  expect(rows[0].p).toContain('16:00:00');
}));

test('news_security es unión: un refetch añade enlaces y nunca borra, aunque el upsert de news cambie', () => inRollback(async (c) => {
  const [a, b] = [await security(c), await security(c)];
  const n = await news(c);
  const NS = 'INSERT INTO news_security (news_id, security_id) VALUES ($1,$2) ON CONFLICT DO NOTHING';
  await c.query(NS, [n, a]);
  // refetch: el artículo se actualiza y ahora además menciona a b
  await c.query("UPDATE news SET headline='Titular corregido', symbols=ARRAY['AAPL.US','MSFT.US'] WHERE news_id=$1", [n]);
  await c.query(NS, [n, a]); // ya estaba: no falla ni duplica
  await c.query(NS, [n, b]);
  expect((await c.query('SELECT count(*)::int AS n FROM news_security WHERE news_id=$1', [n])).rows[0].n).toBe(2);
  // un refetch posterior que solo trae a (b ya no resuelve) no borra el enlace de b: el escritor no hace DELETE
  await c.query(NS, [n, a]);
  expect((await c.query('SELECT count(*)::int AS n FROM news_security WHERE news_id=$1', [n])).rows[0].n).toBe(2);
  // varias noticias por security y varias securities por noticia
  const n2 = await news(c, URL1 + '-2');
  await c.query(NS, [n2, a]);
  expect((await c.query('SELECT count(*)::int AS n FROM news_security WHERE security_id=$1', [a])).rows[0].n).toBe(2);
}));

test('news_security: PK, FK y campos obligatorios', () => inRollback(async (c) => {
  const s = await security(c);
  const n = await news(c);
  const NS = 'INSERT INTO news_security (news_id, security_id) VALUES ($1,$2)';
  await c.query(NS, [n, s]);
  expect((await dbError(c, NS, [n, s]))?.code).toBe('23505');
  expect((await dbError(c, NS, [999999, s]))?.code).toBe('23503');
  expect((await dbError(c, NS, [n, 999999]))?.code).toBe('23503');
  expect((await dbError(c, 'INSERT INTO news_security (news_id) VALUES ($1)', [n]))?.code).toBe('23502');
  expect((await dbError(c, 'DELETE FROM news WHERE news_id=$1', [n]))?.code).toBe('23503');
  expect((await dbError(c, 'DELETE FROM security WHERE security_id=$1', [s]))?.code).toBe('23503');
}));

test('nulls admitidos en symbols, tags y sentiment; sin CHECK de rango; arrays tal cual', () => inRollback(async (c) => {
  await c.query("INSERT INTO news (url, published_at, headline) VALUES ('https://a/1', now(), 'sin nada')");
  const { rows } = await c.query('SELECT symbols, tags, sentiment_polarity, sentiment_neg, sentiment_neu, sentiment_pos FROM news');
  expect(rows[0]).toEqual({ symbols: null, tags: null, sentiment_polarity: null, sentiment_neg: null, sentiment_neu: null, sentiment_pos: null });
  await c.query("INSERT INTO news (url, published_at, headline, symbols, tags, sentiment_polarity, sentiment_pos) VALUES ('https://a/2', now(), 'raros', ARRAY[]::text[], ARRAY['REVENUE GROWTH','Etiqueta Nueva'], 9.9, -3)"); // valores crudos del proveedor
  const r2 = (await c.query("SELECT symbols, tags FROM news WHERE url='https://a/2'")).rows[0];
  expect(r2.symbols).toEqual([]);
  expect(r2.tags).toEqual(['REVENUE GROWTH', 'Etiqueta Nueva']);
  // los 50 símbolos del fixture (CL.COMM, DJI.INDX, OPAI.PVT...) caben tal cual
  await c.query("INSERT INTO news (url, published_at, headline, symbols) VALUES ('https://a/3', now(), 'mercado', $1)", [['DJI.INDX', 'CL.COMM', 'OPAI.PVT', 'JPM-PC.US', ...Array.from({ length: 46 }, (_, i) => `S${i}.US`)]]);
  expect((await c.query("SELECT array_length(symbols,1) AS n FROM news WHERE url='https://a/3'")).rows[0].n).toBe(50);
}));
