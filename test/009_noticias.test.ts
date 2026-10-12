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
const news = (c: pg.PoolClient, headline = 'Titular') =>
  id(c, "INSERT INTO news (published_at, headline) VALUES ('2026-10-10T15:02:42+00:00', $1) RETURNING news_id AS id", [headline]);

test('existen las 2 tablas de noticias y sin columnas que el modelo no tiene', async () => {
  const cols = async (t: string) => (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t])).rows.map((r) => r.column_name);
  expect(await cols('news')).toEqual(['news_id', 'published_at', 'headline', 'summary', 'url', 'publisher']);
  expect(await cols('news_security')).toEqual(['news_id', 'security_id']);
});

test('news: published_at y headline obligatorios; summary, url y publisher nullable', () => inRollback(async (c) => {
  expect((await dbError(c, "INSERT INTO news (headline) VALUES ('x')"))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO news (published_at) VALUES (now())"))?.code).toBe('23502');
  await c.query("INSERT INTO news (published_at, headline) VALUES ('2026-10-10T15:02:42+00:00','Solo lo mínimo')");
  const { rows } = await c.query("SELECT summary, url, publisher, published_at::text AS p FROM news");
  expect(rows[0].summary).toBeNull();
  expect(rows[0].url).toBeNull();
  expect(rows[0].publisher).toBeNull();
  expect(rows[0].p).toContain('2026-10-10');
}));

test('news acepta un artículo con el tamaño del fixture real (texto largo, saltos de línea)', () => inRollback(async (c) => {
  const largo = 'Earlier this month, we reported on Apple...\n\n' + 'x'.repeat(9000);
  await c.query("INSERT INTO news (published_at, headline, summary, url, publisher) VALUES ('2026-10-10T15:02:42+00:00','t',$1,'https://finance.yahoo.com/technology/ai/articles/back-office-agent-wave-already-150242112.html',NULL)", [largo]);
  expect((await c.query('SELECT length(summary) AS n FROM news')).rows[0].n).toBe(largo.length);
}));

test('news_security: PK (news, security), varias securities por noticia y varias noticias por security', () => inRollback(async (c) => {
  const [a, b] = [await security(c), await security(c)];
  const [n1, n2] = [await news(c, 'uno'), await news(c, 'dos')];
  const NS = 'INSERT INTO news_security (news_id, security_id) VALUES ($1,$2)';
  await c.query(NS, [n1, a]);
  await c.query(NS, [n1, b]); // una noticia, dos securities
  await c.query(NS, [n2, a]); // una security, dos noticias
  expect((await dbError(c, NS, [n1, a]))?.code).toBe('23505');
  expect((await dbError(c, NS, [999999, a]))?.code).toBe('23503');
  expect((await dbError(c, NS, [n1, 999999]))?.code).toBe('23503');
  expect((await dbError(c, 'INSERT INTO news_security (news_id) VALUES ($1)', [n1]))?.code).toBe('23502');
}));

test('no se borra una noticia ni una security etiquetadas', () => inRollback(async (c) => {
  const s = await security(c);
  const n = await news(c);
  await c.query('INSERT INTO news_security (news_id, security_id) VALUES ($1,$2)', [n, s]);
  expect((await dbError(c, 'DELETE FROM news WHERE news_id=$1', [n]))?.code).toBe('23503');
  expect((await dbError(c, 'DELETE FROM security WHERE security_id=$1', [s]))?.code).toBe('23503');
}));
