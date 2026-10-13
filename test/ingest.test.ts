import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { capture, type CaptureOptions } from '../src/eodhd/ingest.js';
import type { Job } from '../src/eodhd/jobs.js';
import { replay } from '../src/eodhd/replay.js';

// Estos tests NO llaman a EODHD: hablan con un servidor HTTP local. Un guardia sobre fetch lo garantiza.
const realFetch = globalThis.fetch;
const TOKEN = 'TESTKEY-' + randomUUID();
const TAG = randomUUID(); // hace únicos los cuerpos para no chocar con blobs de ejecuciones anteriores
const BODY_OK = Buffer.from(`﻿{"tag": "${TAG}",\n  "b": 1,   "a": [1, 2]}\n`, 'utf8'); // BOM, espacios y orden de claves no canónicos
const seen: { path: string; token: string | null; fmt: string | null }[] = [];
let server: http.Server;
let base = '';
let flakyHits = new Map<string, number>();

beforeAll(async () => {
  await migrate();
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== '127.0.0.1') throw new Error(`Test sin red: se intentó llamar a ${url.hostname}`);
    return realFetch(input, init);
  });
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    seen.push({ path: url.pathname, token: url.searchParams.get('api_token'), fmt: url.searchParams.get('fmt') });
    const p = url.pathname;
    if (p.startsWith('/api/ok')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(BODY_OK); }
    else if (p.startsWith('/api/same')) { res.writeHead(200); res.end(BODY_OK); }
    else if (p.startsWith('/api/missing')) { res.writeHead(404); res.end(`{"error":"not found ${TAG}"}`); }
    else if (p.startsWith('/api/limit')) { res.writeHead(429); res.end(`{"error":"rate limit ${TAG}"}`); }
    else if (p.startsWith('/api/text')) { res.writeHead(200); res.end(`esto no es json ${TAG}`); }
    else if (p.startsWith('/api/redirect')) { res.writeHead(302, { location: 'http://127.0.0.1:1/otro' }); res.end(); }
    else if (p.startsWith('/api/flaky')) {
      const n = (flakyHits.get(p) ?? 0) + 1; flakyHits.set(p, n);
      if (n === 1) { res.writeHead(500); res.end(`{"error":"boom ${TAG}"}`); } else { res.writeHead(200); res.end(`{"flaky":"${TAG}"}`); }
    }
    else if (p.startsWith('/api/slow')) { /* no responde nunca */ }
    else if (p.startsWith('/api/cut')) { res.writeHead(200, { 'content-length': '1000' }); res.write('{"parcial":'); setTimeout(() => req.socket.destroy(), 20); }
    else { res.writeHead(500); res.end('ruta de test desconocida'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

async function cleanup() {
  const hashes = (await pool.query<{ h: string }>("SELECT DISTINCT r.content_hash AS h FROM raw_payload r JOIN ingestion_run i USING (ingestion_run_id) WHERE i.scope LIKE 'test:%' AND r.content_hash IS NOT NULL")).rows.map((r) => r.h);
  await pool.query("DELETE FROM raw_payload WHERE ingestion_run_id IN (SELECT ingestion_run_id FROM ingestion_run WHERE scope LIKE 'test:%')");
  await pool.query("DELETE FROM ingestion_run WHERE scope LIKE 'test:%'");
  if (hashes.length) await pool.query('DELETE FROM payload_blob WHERE content_hash = ANY($1) AND NOT EXISTS (SELECT 1 FROM raw_payload WHERE content_hash = payload_blob.content_hash)', [hashes]);
}

beforeEach(async () => { seen.length = 0; flakyHits = new Map(); await cleanup(); });
afterAll(async () => {
  await cleanup();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  vi.unstubAllGlobals();
  await closePool();
});

const scope = (name: string) => `test:${name}:${randomUUID()}`;
const job = (endpoint: string, over: Partial<Job> = {}): Job => ({ endpoint, params: {}, cost: 1, ...over });
const opts = (over: CaptureOptions = {}): CaptureOptions => ({ apiKey: TOKEN, baseUrl: base, timeoutMs: 2_000, retryDelayMs: 0, sleep: async () => {}, ...over });
const rows = async (runId: string) => (await pool.query('SELECT * FROM raw_payload WHERE ingestion_run_id = $1 ORDER BY raw_payload_id', [runId])).rows;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('200 y 404 son respuesta con cuerpo en payload_blob; una raw_payload por intento y una ingestion_run por scope', async () => {
  const s = await capture(scope('estados'), [job('ok/1'), job('missing/1')], opts());
  expect(s).toMatchObject({ status: 'partial', attempts: 2, ok: 1, errors: 1, jobsDone: 2, jobsSkipped: 0 });
  const r = await rows(s.runId);
  expect(r.map((x) => x.http_status)).toEqual([200, 404]);
  expect(r.every((x) => x.transport_error === null && x.parse_status === 'pending' && x.content_hash)).toBe(true);
  const b404 = (await pool.query('SELECT body FROM payload_blob WHERE content_hash = $1', [r[1].content_hash])).rows[0].body as Buffer;
  expect(b404.toString()).toBe(`{"error":"not found ${TAG}"}`); // el cuerpo de un error también se guarda
  const run = (await pool.query('SELECT status, req_count, ok_count, error_count, finished_at FROM ingestion_run WHERE ingestion_run_id = $1', [s.runId])).rows[0];
  expect(run).toMatchObject({ status: 'partial', req_count: 2, ok_count: 1, error_count: 1 });
  expect(run.finished_at).not.toBeNull();
  expect((await pool.query("SELECT count(*)::int AS n FROM ingestion_run WHERE scope = $1", [s.scope])).rows[0].n).toBe(1);
});

test('la llamada lleva fmt=json y el token, pero el servidor es el único que lo ve', async () => {
  await capture(scope('token'), [job('ok/1')], opts());
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ path: '/api/ok/1', token: TOKEN, fmt: 'json' });
});

test('429 es respuesta con cuerpo y para la corrida sin gastar más cuota', async () => {
  const s = await capture(scope('429'), [job('limit/1'), job('ok/1'), job('ok/2')], opts({ maxAttempts: 3 })); // con intentos de sobra: el 429 no se reintenta
  expect(s.stoppedBy).toBe('rate_limit');
  expect(s).toMatchObject({ status: 'failed', attempts: 1, errors: 1, jobsDone: 0, jobsSkipped: 3 }); // el 429 deja el trabajo sin completar
  expect(seen).toHaveLength(1); // los otros dos trabajos no se llamaron
  const r = await rows(s.runId);
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ http_status: 429, transport_error: null });
  expect((await pool.query('SELECT body FROM payload_blob WHERE content_hash = $1', [r[0].content_hash])).rows[0].body.toString()).toContain('rate limit');
});

test('cuerpo idéntico dos veces: 2 raw_payload y 1 payload_blob (también entre corridas)', async () => {
  const s1 = await capture(scope('dedup'), [job('same/1'), job('same/2')], opts());
  const r1 = await rows(s1.runId);
  expect(r1).toHaveLength(2);
  expect(r1[0].content_hash).toBe(r1[1].content_hash);
  expect((await pool.query('SELECT count(*)::int AS n FROM payload_blob WHERE content_hash = $1', [r1[0].content_hash])).rows[0].n).toBe(1);
  const s2 = await capture(scope('dedup'), [job('same/3')], opts()); // otra corrida, mismo cuerpo
  expect((await rows(s2.runId))[0].content_hash).toBe(r1[0].content_hash);
  expect((await pool.query('SELECT count(*)::int AS n FROM raw_payload WHERE content_hash = $1', [r1[0].content_hash])).rows[0].n).toBe(3);
  expect((await pool.query('SELECT count(*)::int AS n FROM payload_blob WHERE content_hash = $1', [r1[0].content_hash])).rows[0].n).toBe(1);
});

test('el hash es el de los BYTES exactos y el cuerpo se guarda tal cual (BOM, espacios y orden de claves intactos)', async () => {
  const s = await capture(scope('bytes'), [job('ok/1')], opts());
  const r = (await rows(s.runId))[0];
  const blob = (await pool.query('SELECT body, size_bytes FROM payload_blob WHERE content_hash = $1', [r.content_hash])).rows[0];
  expect(Buffer.compare(blob.body, BODY_OK)).toBe(0); // idénticos byte a byte
  expect(Number(blob.size_bytes)).toBe(BODY_OK.length);
  expect(r.content_hash).toBe(sha(BODY_OK));
  // un hash de JSON re-serializado o de texto decodificado sería otro: el BOM se pierde al decodificar
  expect(r.content_hash).not.toBe(sha(Buffer.from(JSON.stringify(JSON.parse(BODY_OK.toString('utf8').replace(/^﻿/, ''))))));
  expect(r.content_hash).not.toBe(sha(Buffer.from(BODY_OK.toString('utf8').replace(/^﻿/, ''))));
  expect(blob.body.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
});

test('timeout = transport_error: sin http_status, content_hash ni parse_status', async () => {
  const s = await capture(scope('timeout'), [job('slow/1')], opts({ timeoutMs: 150 }));
  expect(s).toMatchObject({ status: 'failed', attempts: 1, ok: 0, errors: 1 });
  const r = (await rows(s.runId))[0];
  expect(r).toMatchObject({ http_status: null, content_hash: null, parse_status: null, parse_error: null });
  expect(r.transport_error).toMatch(/Timeout/i);
  expect((await pool.query("SELECT count(*)::int AS n FROM payload_blob WHERE content_hash IS NULL")).rows[0].n).toBe(0);
});

test('conexión cortada a mitad del cuerpo = transport_error (no se guarda un cuerpo truncado)', async () => {
  const s = await capture(scope('corte'), [job('cut/1')], opts());
  const r = (await rows(s.runId))[0];
  expect(r).toMatchObject({ http_status: null, content_hash: null, parse_status: null });
  expect(r.transport_error).toBeTruthy();
  const blobs = await pool.query("SELECT count(*)::int AS n FROM payload_blob WHERE body = $1", [Buffer.from('{"parcial":')]);
  expect(blobs.rows[0].n).toBe(0);
});

test('los reintentos son filas nuevas: 500 y luego 200', async () => {
  const s = await capture(scope('reintento'), [job('flaky/1')], opts({ maxAttempts: 3 }));
  const r = await rows(s.runId);
  expect(r.map((x) => x.http_status)).toEqual([500, 200]);
  expect(r.map((x) => x.endpoint)).toEqual(['flaky/1', 'flaky/1']);
  expect(s).toMatchObject({ attempts: 2, ok: 1, errors: 1, jobsDone: 1 });
  expect(seen).toHaveLength(2);
  const run = (await pool.query('SELECT req_count, ok_count, error_count FROM ingestion_run WHERE ingestion_run_id = $1', [s.runId])).rows[0];
  expect(run).toEqual({ req_count: 2, ok_count: 1, error_count: 1 });
});

test('los fallos de transporte también se reintentan, cada intento una fila; un 404 no se reintenta', async () => {
  const s = await capture(scope('reintento2'), [job('cut/1'), job('missing/1')], opts({ maxAttempts: 3 }));
  const r = await rows(s.runId);
  expect(r.filter((x) => x.endpoint === 'cut/1')).toHaveLength(3);
  expect(r.filter((x) => x.endpoint === 'missing/1')).toHaveLength(1);
  expect(s.attempts).toBe(4);
});

test('el presupuesto por corrida para ANTES de superarlo', async () => {
  const jobs = [1, 2, 3, 4, 5].map((i) => job(`ok/${i}`));
  const s = await capture(scope('presupuesto'), jobs, opts({ budget: 3 }));
  expect(s).toMatchObject({ attempts: 3, spent: 3, budget: 3, jobsDone: 3, jobsSkipped: 2, stoppedBy: 'budget', status: 'partial' });
  expect(seen).toHaveLength(3); // el servidor vio exactamente 3 peticiones
  // un trabajo que no cabe no se llama ni a medias
  seen.length = 0;
  const caro = await capture(scope('caro'), [job('ok/1', { cost: 1 }), job('ok/2', { cost: 10 }), job('ok/3', { cost: 1 })], opts({ budget: 5 }));
  expect(caro).toMatchObject({ attempts: 1, spent: 1, jobsSkipped: 2, stoppedBy: 'budget' });
  expect(seen).toHaveLength(1);
  // y los reintentos también gastan presupuesto
  seen.length = 0;
  const rein = await capture(scope('presupuesto2'), [job('cut/1')], opts({ budget: 2, maxAttempts: 5 }));
  expect(rein.attempts).toBe(2);
  expect(rein.stoppedBy).toBe('budget');
  expect(seen).toHaveLength(2);
});

test('sin trabajos la corrida se cierra en ok; el presupuesto por defecto sale de la configuración', async () => {
  const s = await capture(scope('vacia'), [], opts());
  expect(s).toMatchObject({ status: 'ok', attempts: 0 });
  const { config } = await import('../src/config.js');
  expect(config.runBudget).toBeLessThan(20); // por debajo del límite diario del plan Free
});

test('el api_token NUNCA se guarda: ni en params ni en ninguna columna, ni siquiera en un error', async () => {
  const sa = await capture(scope('secreto'), [job('ok/1'), job('missing/1'), job('limit/1')], opts());
  const sb = await capture(scope('secreto2'), [job('slow/1'), job('cut/1'), job('redirect/1')], opts({ timeoutMs: 150 }));
  // el servidor sí lo recibió: la llamada iba autenticada
  expect(seen.filter((x) => x.token === TOKEN).length).toBeGreaterThanOrEqual(5);
  // ninguna fila de las tablas de ingesta lo contiene, serializada entera
  for (const id of [sa.runId, sb.runId]) {
    const run = (await pool.query('SELECT to_jsonb(i)::text AS t FROM ingestion_run i WHERE ingestion_run_id = $1', [id])).rows[0].t;
    expect(run).not.toContain(TOKEN);
    for (const r of (await pool.query('SELECT to_jsonb(r)::text AS t FROM raw_payload r WHERE ingestion_run_id = $1', [id])).rows) expect(r.t).not.toContain(TOKEN);
    expect((await pool.query("SELECT count(*)::int AS n FROM raw_payload WHERE ingestion_run_id = $1 AND (params ? 'api_token' OR params::text ILIKE '%token%')", [id])).rows[0].n).toBe(0);
  }
  // la redirección no se sigue (el token no viaja a otro destino): es un fallo de transporte
  const redirect = (await rows(sb.runId)).find((x) => x.endpoint === 'redirect/1')!;
  expect(redirect.transport_error).toBeTruthy();
  expect(seen.filter((x) => x.path === '/otro')).toHaveLength(0);
  // y los trabajos con api_token en params se rechazan
  await expect(capture(scope('mal'), [job('ok/1', { params: { api_token: 'x' } })], opts())).rejects.toThrow(/api_token/);
});

test('si el token apareciera en un mensaje de error, se enmascara', async () => {
  // el cliente nunca lo pone en el mensaje, pero por si un error de red lo reflejara: con la clave "ECONNREFUSED" el
  // propio texto del error la contiene y tiene que salir enmascarado.
  const cerrado = http.createServer();
  await new Promise<void>((r) => cerrado.listen(0, '127.0.0.1', r));
  const puerto = (cerrado.address() as AddressInfo).port;
  await new Promise((r) => cerrado.close(r)); // puerto sin nadie escuchando: rechazo inmediato
  const s = await capture(scope('mascara'), [job('ok/1')], { apiKey: 'ECONNREFUSED', baseUrl: `http://127.0.0.1:${puerto}/api`, timeoutMs: 2_000, retryDelayMs: 0 });
  const r = (await rows(s.runId))[0];
  expect(r.transport_error).toContain('***');
  expect(r.transport_error).not.toContain('ECONNREFUSED');
});

test('al arrancar se cierran como failed las corridas del mismo scope que se quedaron en running', async () => {
  const sc = scope('colgada');
  const otro = scope('otro');
  const colgada = (await pool.query("INSERT INTO ingestion_run (provider, scope) VALUES ('eodhd', $1) RETURNING ingestion_run_id AS id", [sc])).rows[0].id;
  const colgada2 = (await pool.query("INSERT INTO ingestion_run (provider, scope) VALUES ('eodhd', $1) RETURNING ingestion_run_id AS id", [sc])).rows[0].id;
  const ajena = (await pool.query("INSERT INTO ingestion_run (provider, scope) VALUES ('eodhd', $1) RETURNING ingestion_run_id AS id", [otro])).rows[0].id;
  const s = await capture(sc, [job('ok/1')], opts());
  expect(s.closedStale).toBe(2);
  const st = (await pool.query('SELECT ingestion_run_id AS id, status, finished_at FROM ingestion_run WHERE ingestion_run_id = ANY($1) ORDER BY 1', [[colgada, colgada2, ajena]])).rows;
  expect(st.find((x) => x.id === colgada)).toMatchObject({ status: 'failed' });
  expect(st.find((x) => x.id === colgada)!.finished_at).not.toBeNull();
  expect(st.find((x) => x.id === colgada2)!.status).toBe('failed');
  expect(st.find((x) => x.id === ajena)!.status).toBe('running'); // otro scope: intacta
  expect(s.runId).not.toBe(colgada);
  expect((await pool.query('SELECT status FROM ingestion_run WHERE ingestion_run_id = $1', [s.runId])).rows[0].status).toBe('ok');
});

test('no se cierra una corrida viva: dos capturas simultáneas del mismo scope no se pisan', async () => {
  const sc = scope('concurrente');
  const lenta = capture(sc, [job('slow/1')], opts({ timeoutMs: 600 }));
  await new Promise((r) => setTimeout(r, 200)); // la primera ya tiene el lock
  await expect(capture(sc, [job('ok/1')], opts())).rejects.toThrow(/Ya hay una corrida/);
  const s = await lenta;
  expect(s.status).toBe('failed');
  expect((await pool.query("SELECT count(*)::int AS n FROM ingestion_run WHERE scope = $1", [sc])).rows[0].n).toBe(1); // la segunda no creó ni cerró nada
  // terminada la primera, el lock se libera
  expect((await capture(sc, [job('ok/1')], opts())).status).toBe('ok');
});

test('una excepción inesperada no deja la corrida en running', async () => {
  const sc = scope('rota');
  await expect(capture(sc, [job('ok/{symbol}')], opts())).rejects.toThrow(/símbolo/); // plantilla sin símbolo
  const st = (await pool.query("SELECT status, finished_at FROM ingestion_run WHERE scope = $1", [sc])).rows;
  expect(st).toHaveLength(1);
  expect(st[0].status).toBe('failed');
  expect(st[0].finished_at).not.toBeNull();
});

test('la ruta y los parámetros guardados son la plantilla y el símbolo, sin el token', async () => {
  const s = await capture(scope('plantilla'), [
    job('ok/{symbol}', { symbol: 'AAPL.US', params: { period: 'd' } }),
    job('ok/{code}', { params: { code: 'LSE', delisted: '1' } }),
  ], opts());
  const r = await rows(s.runId);
  expect(r[0]).toMatchObject({ endpoint: 'ok/{symbol}', provider_symbol: 'AAPL.US', params: { period: 'd' } });
  expect(r[1]).toMatchObject({ endpoint: 'ok/{code}', provider_symbol: null, params: { code: 'LSE', delisted: '1' } });
  expect(seen.map((x) => x.path)).toEqual(['/api/ok/AAPL.US', '/api/ok/LSE']);
});

// ------------------------------------------------------------------ replay
test('replay: relee de raw_payload + payload_blob sin red y marca parse_status', async () => {
  const s = await capture(scope('replay'), [job('ok/1'), job('missing/1'), job('text/1'), job('cut/1')], opts());
  const r = await rows(s.runId);
  const idOf = (ep: string) => r.find((x) => x.endpoint === ep)!.raw_payload_id;
  const fetchMock = vi.fn(() => { throw new Error('replay no debe usar la red'); });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const out = await replay({ runId: s.runId });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toEqual({ checked: 3, ok: 1, error: 2 }); // la fila de transport_error no se relee
  } finally {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname !== '127.0.0.1') throw new Error(`Test sin red: se intentó llamar a ${url.hostname}`);
      return realFetch(input, init);
    });
  }
  const after = (await rows(s.runId));
  const get = (ep: string) => after.find((x) => x.raw_payload_id === idOf(ep))!;
  expect(get('ok/1')).toMatchObject({ parse_status: 'ok', parse_error: null });
  expect(get('missing/1')).toMatchObject({ parse_status: 'error' });
  expect(get('missing/1').parse_error).toContain('HTTP 404');
  expect(get('text/1')).toMatchObject({ parse_status: 'error' });
  expect(get('text/1').parse_error).toContain('JSON inválido');
  expect(get('cut/1')).toMatchObject({ parse_status: null, parse_error: null, transport_error: expect.any(String) });
  // volver a pasar el replay no cambia nada: solo recorre las filas en pending
  expect(await replay({ runId: s.runId })).toEqual({ checked: 0, ok: 0, error: 0 });
});

test('replay detecta un cuerpo purgado y un cuerpo que ya no casa con su hash', async () => {
  const s = await capture(scope('replay2'), [job('ok/1'), job('text/1')], opts());
  const r = await rows(s.runId);
  await pool.query('UPDATE payload_blob SET body = NULL, purged_at = now() WHERE content_hash = $1', [r[0].content_hash]);
  await pool.query('UPDATE payload_blob SET body = $2 WHERE content_hash = $1', [r[1].content_hash, Buffer.from('{"alterado":true}')]);
  expect(await replay({ runId: s.runId })).toEqual({ checked: 2, ok: 0, error: 2 });
  const after = await rows(s.runId);
  expect(after[0].parse_error).toContain('purgado');
  expect(after[1].parse_error).toContain('hash');
});

test('replay sin runId recorre todas las filas pendientes', async () => {
  const a = await capture(scope('replay3a'), [job('ok/1')], opts());
  const b = await capture(scope('replay3b'), [job('ok/2')], opts());
  const out = await replay();
  expect(out.checked).toBeGreaterThanOrEqual(2);
  for (const id of [a.runId, b.runId]) expect((await rows(id))[0].parse_status).toBe('ok');
});
