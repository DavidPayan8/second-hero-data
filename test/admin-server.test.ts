import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { hashPassword, parseUsers } from '../src/admin/auth.js';
import { crearServidor } from '../src/admin/server.js';
import { VIEWER_MAX_BYTES } from '../src/admin/viewer.js';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const LEI = '5493006QMFDDMYWIAM13';
const SECRETO = 'secreto-de-prueba-largo-y-aleatorio';
const users = parseUsers(`david=${hashPassword('clave-david')},alberto=${hashPassword('clave-alberto')}`);

// El servidor usa el mismo cliente (dentro de una transacción que se revierte) que el test.
async function conServidor(fn: (url: string, c: pg.PoolClient) => Promise<void>): Promise<void> {
  await inRollback(async (c) => {
    const srv = crearServidor({ db: c, users, secret: SECRETO });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, c); } finally { await new Promise((r) => srv.close(r)); }
  });
}
const post = (url: string, body: unknown, cookie?: string, tipo = 'application/json') =>
  fetch(url, { method: 'POST', headers: { 'content-type': tipo, ...(cookie ? { cookie } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function login(url: string, usuario = 'david', clave = 'clave-david'): Promise<string> {
  const r = await post(`${url}/api/login`, { usuario, clave });
  expect(r.status).toBe(200);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
async function sembrar(c: pg.PoolClient): Promise<void> {
  const hash = createHash('sha256').update('blob-srv').digest('hex');
  await c.query("INSERT INTO payload_blob (content_hash, body, body_format, size_bytes) VALUES ($1,'\\x7b7d','json',2)", [hash]);
  await c.query("INSERT INTO esef_filing (fxo_id, content_hash, lei, country, period_start, period_end, extractor_version) VALUES ('test-srv',$1,$2,'ES','2023-01-01','2023-12-31','test')", [hash, LEI]);
  await c.query("INSERT INTO esef_lei_isin (lei, isin, source, matched_symbol, matched_type, matched_name) VALUES ($1,'ES0113900J37','gleif','BNC.LSE','Common Stock','<script>alert(1)</script>')", [LEI]);
}

describe('acceso', () => {
  test('sin cookie las rutas /api devuelven 401; el login malo da el mismo cuerpo con usuario inexistente', () => conServidor(async (url) => {
    expect((await fetch(`${url}/api/revision`)).status).toBe(401);
    expect((await fetch(`${url}/api/blobs?q=a`)).status).toBe(401);
    const malaClave = await post(`${url}/api/login`, { usuario: 'david', clave: 'mala' });
    const sinUsuario = await post(`${url}/api/login`, { usuario: 'nadie', clave: 'mala' });
    expect(malaClave.status).toBe(401);
    expect(sinUsuario.status).toBe(401);
    expect(await malaClave.text()).toBe(await sinUsuario.text());
    expect((await post(`${url}/api/login`, { usuario: 'david', clave: '' })).status).toBe(401);
  }));
  test('con login correcto /api/me devuelve el usuario; una cookie manipulada da 401', () => conServidor(async (url) => {
    const cookie = await login(url);
    const me = await fetch(`${url}/api/me`, { headers: { cookie } });
    expect(await me.json()).toEqual({ usuario: 'david' });
    expect((await fetch(`${url}/api/me`, { headers: { cookie: cookie + 'x' } })).status).toBe(401);
  }));
  test('la cookie es HttpOnly y SameSite=Strict', () => conServidor(async (url) => {
    const r = await post(`${url}/api/login`, { usuario: 'david', clave: 'clave-david' });
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
  }));
});

describe('límite de intentos', () => {
  test('tras 10 logins fallidos desde la misma IP responde 429, incluso con la clave buena', () => conServidor(async (url) => {
    for (let i = 0; i < 10; i++) expect((await post(`${url}/api/login`, { usuario: 'david', clave: 'mala' })).status).toBe(401);
    expect((await post(`${url}/api/login`, { usuario: 'david', clave: 'mala' })).status).toBe(429);
    expect((await post(`${url}/api/login`, { usuario: 'david', clave: 'clave-david' })).status).toBe(429);
  }));
});

describe('detrás de un proxy (ADMIN_TRUST_PROXY)', () => {
  async function conProxy(fn: (url: string) => Promise<void>): Promise<void> {
    await inRollback(async (c) => {
      const srv = crearServidor({ db: c, users, secret: SECRETO, trustProxy: true });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`); } finally { await new Promise((r) => srv.close(r)); }
    });
  }
  const intento = (url: string, ip: string, clave: string) => fetch(`${url}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `1.1.1.1, ${ip}` }, body: JSON.stringify({ usuario: 'david', clave }),
  });
  test('el límite se cuenta por la última IP de X-Forwarded-For (la que añade el proxy), sin el puerto', () => conProxy(async (url) => {
    for (let i = 0; i < 10; i++) expect((await intento(url, '9.9.9.9:5555', 'mala')).status).toBe(401);
    expect((await intento(url, '9.9.9.9:6666', 'mala')).status).toBe(429);
    expect((await intento(url, '8.8.8.8:1', 'clave-david')).status).toBe(200);
  }));
  test('con x-forwarded-proto https la cookie lleva Secure aunque NODE_ENV no sea production', () => conProxy(async (url) => {
    const r = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ usuario: 'david', clave: 'clave-david' }) });
    expect(r.headers.get('set-cookie')).toContain('Secure');
  }));
  test('sin ADMIN_TRUST_PROXY se ignoran las cabeceras X-Forwarded-*', () => conServidor(async (url) => {
    for (let i = 0; i < 10; i++) await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `7.7.7.${i}` }, body: JSON.stringify({ usuario: 'david', clave: 'mala' }) });
    const r = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '7.7.7.99', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ usuario: 'david', clave: 'clave-david' }) });
    expect(r.status).toBe(429);
  }));
});

describe('revisión', () => {
  test('la decisión guarda reviewed_by de la sesión aunque el cuerpo traiga otro', () => conServidor(async (url, c) => {
    await sembrar(c);
    const cookie = await login(url, 'alberto', 'clave-alberto');
    const r = await post(`${url}/api/revision/decision`, { lei: LEI, isin: 'ES0113900J37', decision: 'accepted', reviewedBy: 'otro' }, cookie);
    expect(r.status).toBe(200);
    const e = (await c.query('SELECT reviewed_by FROM esef_lei_isin WHERE isin=$1', ['ES0113900J37'])).rows[0];
    expect(e.reviewed_by).toBe('alberto');
    const lista = await (await fetch(`${url}/api/revision?soloPendientes=1`, { headers: { cookie } })).json() as { empresas: unknown[] };
    expect(lista.empresas).toEqual([]);
  }));
  test('los errores de negocio salen con su estado y los POST exigen application/json', () => conServidor(async (url, c) => {
    await sembrar(c);
    const cookie = await login(url);
    expect((await post(`${url}/api/revision/decision`, { lei: LEI, isin: 'ES0113900J37', decision: 'borrar' }, cookie)).status).toBe(400);
    expect((await post(`${url}/api/revision/decision`, { lei: LEI, isin: 'ES0000000000', decision: 'accepted' }, cookie)).status).toBe(404);
    expect((await post(`${url}/api/revision/decision`, 'lei=1', cookie, 'application/x-www-form-urlencoded')).status).toBe(415);
    expect((await post(`${url}/api/revision/decision`, '{no es json', cookie)).status).toBe(400);
  }));
  test('el nombre con HTML se devuelve tal cual, como dato JSON', () => conServidor(async (url, c) => {
    await sembrar(c);
    const cookie = await login(url);
    const lista = await (await fetch(`${url}/api/revision`, { headers: { cookie } })).json() as { empresas: { filas: { name: string }[] }[] };
    expect(lista.empresas[0]!.filas[0]!.name).toBe('<script>alert(1)</script>');
  }));
});

describe('visor y estáticos', () => {
  test('un blob por encima del tope da 413; hash mal formado 400', () => conServidor(async (url, c) => {
    const h = createHash('sha256').update('grande').digest('hex');
    await c.query("INSERT INTO payload_blob (content_hash, body, body_format, size_bytes) VALUES ($1,'\\x7b7d','json',$2)", [h, VIEWER_MAX_BYTES + 1]);
    const cookie = await login(url);
    expect((await fetch(`${url}/api/blobs/${h}`, { headers: { cookie } })).status).toBe(413);
    expect((await fetch(`${url}/api/blobs/zzz`, { headers: { cookie } })).status).toBe(400);
  }));
  test('index.html se sirve sin sesión; las rutas con .. o desconocidas dan 404', () => conServidor(async (url) => {
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect((await fetch(`${url}/static/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${url}/static/../../package.json`)).status).toBe(404);
    expect((await fetch(`${url}/nada`)).status).toBe(404);
  }));
});
