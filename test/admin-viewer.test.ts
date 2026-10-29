import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { abrir, buscar, VIEWER_MAX_BYTES, VisorError } from '../src/admin/viewer.js';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { compressBody, decodeBody, ESEF_BODY_FORMAT } from '../src/esef/codec.js';
import { inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function blob(c: pg.PoolClient, raw: Buffer, format: 'json' | 'json+zstd' | string, opts: { hash?: string; size?: number; endpoint?: string } = {}): Promise<string> {
  const hash = opts.hash ?? sha(raw);
  const body = format === ESEF_BODY_FORMAT ? compressBody(raw) : raw;
  await c.query('INSERT INTO payload_blob (content_hash, body, body_format, size_bytes) VALUES ($1,$2,$3,$4)', [hash, body, format, opts.size ?? raw.length]);
  if (opts.endpoint) {
    const run = (await c.query("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd','viewer:test','ok', now()) RETURNING ingestion_run_id AS id")).rows[0].id;
    await c.query("INSERT INTO raw_payload (ingestion_run_id, endpoint, http_status, content_hash) VALUES ($1,$2,200,$3)", [run, opts.endpoint, hash]);
  }
  return hash;
}

describe('abrir', () => {
  test('json+zstd y json se abren y devuelven el objeto, con hashOk', () => inRollback(async (c) => {
    const obj = { Code: 'TEF', Isin: 'ES0178430E18', n: [1, 2] };
    const raw = Buffer.from(JSON.stringify(obj));
    const h1 = await blob(c, raw, ESEF_BODY_FORMAT);
    const raw2 = Buffer.from(JSON.stringify({ otro: true }));
    const h2 = await blob(c, raw2, 'json');
    const a = await abrir(c, h1);
    expect(a.json).toEqual(obj);
    expect(a.hashOk).toBe(true);
    expect(a.resumen.bodyFormat).toBe(ESEF_BODY_FORMAT);
    expect((await abrir(c, h2)).json).toEqual({ otro: true });
  }));
  test('hash que no coincide con el contenido -> hashOk false, sin caerse', () => inRollback(async (c) => {
    const raw = Buffer.from('{"a":1}');
    const falso = sha(Buffer.from('otra cosa'));
    await blob(c, raw, 'json', { hash: falso });
    const a = await abrir(c, falso);
    expect(a.hashOk).toBe(false);
    expect(a.json).toEqual({ a: 1 });
  }));
  test('body_format desconocido -> 422; cuerpo que no es JSON -> 422', () => inRollback(async (c) => {
    const h1 = await blob(c, Buffer.from('{"a":1}'), 'raro');
    await expect(abrir(c, h1)).rejects.toMatchObject({ status: 422 });
    const h2 = await blob(c, Buffer.from('esto no es json'), 'json');
    await expect(abrir(c, h2)).rejects.toMatchObject({ status: 422 });
  }));
  test('tamaño mayor que el tope -> 413 sin descomprimir', () => inRollback(async (c) => {
    const h = await blob(c, Buffer.from('{"a":1}'), ESEF_BODY_FORMAT, { size: VIEWER_MAX_BYTES + 1 });
    await expect(abrir(c, h)).rejects.toMatchObject({ status: 413 });
  }));
  test('hash inexistente o mal formado -> 404 / 400; purgado -> 404', () => inRollback(async (c) => {
    await expect(abrir(c, '0'.repeat(64))).rejects.toMatchObject({ status: 404 });
    await expect(abrir(c, "x' OR 1=1 --")).rejects.toMatchObject({ status: 400 });
    await c.query("INSERT INTO payload_blob (content_hash, body, body_format, size_bytes, purged_at) VALUES ($1,NULL,'json',5, now())", ['a'.repeat(64)]);
    await expect(abrir(c, 'a'.repeat(64))).rejects.toBeInstanceOf(VisorError);
    await expect(abrir(c, 'a'.repeat(64))).rejects.toMatchObject({ status: 404 });
  }));
});

describe('tope de descompresión', () => {
  test('decodeBody con maxBytes corta una bomba zstd sin devolver el cuerpo', () => {
    const bomba = compressBody(Buffer.alloc(5_000_000));
    expect(bomba.length).toBeLessThan(10_000);
    expect(() => decodeBody(bomba, ESEF_BODY_FORMAT, 1_000_000)).toThrow();
    expect(decodeBody(bomba, ESEF_BODY_FORMAT, 6_000_000).length).toBe(5_000_000);
  });
  test('abrir da 413 aunque size_bytes mienta (diga 2 y el cuerpo descomprima a más del tope)', () => inRollback(async (c) => {
    const grande = Buffer.alloc(VIEWER_MAX_BYTES + 1024, 0x20);
    const h = await blob(c, grande, ESEF_BODY_FORMAT, { size: 2 });
    await expect(abrir(c, h)).rejects.toMatchObject({ status: 413 });
  }));
});

describe('buscar', () => {
  test('por prefijo de hash y por texto del endpoint; q vacío -> 400', () => inRollback(async (c) => {
    const h = await blob(c, Buffer.from('{"x":1}'), 'json', { endpoint: 'exchange-symbol-list/{code}' });
    expect((await buscar(c, h.slice(0, 8))).map((r) => r.contentHash)).toContain(h);
    const porEndpoint = await buscar(c, 'symbol-list');
    expect(porEndpoint.map((r) => r.contentHash)).toContain(h);
    expect(porEndpoint.find((r) => r.contentHash === h)!.endpoint).toBe('exchange-symbol-list/{code}');
    await expect(buscar(c, '  ')).rejects.toMatchObject({ status: 400 });
  }));
  test('los comodines de LIKE del texto buscado se tratan como texto', () => inRollback(async (c) => {
    await blob(c, Buffer.from('{"y":1}'), 'json', { endpoint: 'abc' });
    expect(await buscar(c, '%')).toEqual([]);
  }));
});
