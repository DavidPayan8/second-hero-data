import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { replay } from '../src/eodhd/replay.js';
import { captureBatch, captureIndex, parseIndexPages, planBatch, readIndexPhoto } from '../src/esef/capture.js';
import { chosenFilings } from '../src/esef/choose.js';
import { compressBody, decodeBody, ESEF_BODY_FORMAT } from '../src/esef/codec.js';
import { ESEF_CONFIG } from '../src/esef/config.js';
import { extractAll, extractReport } from '../src/esef/extract.js';

// ESEF (P19, fase 1): captura contra un servidor local (estos tests NO llaman a filings.xbrl.org), crudo comprimido con zstd,
// extractor y elección de presentación. Los cuerpos son sintéticos con la forma real medida en el spike; los tests de la muestra
// real usan fixtures/esef/ (no se suben) y se saltan si no están.
const realFetch = globalThis.fetch;
const UA = 'Second hero pruebas contacto@dominio-de-prueba.test';

// ---- servidor local: índice JSON:API paginado + ficheros xBRL-JSON
interface IdxFiling { fxo_id: string; lei: string; country: string; period_end: string; error_count?: number; processed?: string; json_url?: string | null }
let server: http.Server;
let base = '';
let index: IdxFiling[] = [];
let files = new Map<string, Buffer>(); // json_url -> cuerpo
let status = new Map<string, number>(); // ruta -> estado forzado
const seen: { path: string; ua: string | null; at: number }[] = [];

const jsonUrl = (f: IdxFiling) => (f.json_url === undefined ? `/${f.lei}/${f.period_end}/${f.fxo_id}.json` : f.json_url);

function indexPage(size: number, page: number): object {
  const leis = [...new Set(index.map((f) => f.lei))];
  const slice = index.slice((page - 1) * size, page * size);
  return {
    data: slice.map((f, i) => ({
      type: 'filing', id: String((page - 1) * size + i + 1),
      attributes: {
        fxo_id: f.fxo_id, country: f.country, period_end: f.period_end, error_count: f.error_count ?? 0, warning_count: 0, inconsistency_count: 0,
        processed: f.processed ?? '2024-01-01 00:00:00.000000', date_added: '2024-01-01 00:00:00', sha256: 'a'.repeat(64),
        json_url: jsonUrl(f), report_url: `/${f.fxo_id}.xhtml`, viewer_url: `/${f.fxo_id}/viewer.html`, package_url: null,
      },
      relationships: { entity: { data: { type: 'entity', id: String(leis.indexOf(f.lei) + 1) } } },
    })),
    included: [...new Set(slice.map((f) => f.lei))].map((lei) => ({ type: 'entity', id: String(leis.indexOf(lei) + 1), attributes: { identifier: lei, name: `Empresa ${lei}` } })),
    meta: { count: index.length },
  };
}

beforeAll(async () => {
  await migrate();
  await seed();
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== '127.0.0.1') throw new Error(`Test sin red: se intentó llamar a ${url.hostname}`);
    return realFetch(input, init);
  });
  server = http.createServer((req, res) => {
    seen.push({ path: req.url!, ua: req.headers['user-agent'] ?? null, at: Date.now() });
    const url = new URL(req.url!, 'http://x');
    const forced = status.get(url.pathname);
    if (forced) { res.writeHead(forced); res.end('{"error":"forzado"}'); return; }
    if (url.pathname === '/api/filings') {
      res.writeHead(200, { 'content-type': 'application/vnd.api+json' });
      res.end(JSON.stringify(indexPage(Number(url.searchParams.get('page[size]')), Number(url.searchParams.get('page[number]')))));
      return;
    }
    const body = files.get(url.pathname);
    if (!body) { res.writeHead(404); res.end('{"error":"no encontrado"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
async function cleanAll() {
  for (const sql of ['DELETE FROM esef_fact', 'DELETE FROM esef_filing', 'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run']) await pool.query(sql);
}
beforeEach(async () => { seen.length = 0; index = []; files = new Map(); status = new Map(); await cleanAll(); });
afterAll(async () => { await cleanAll(); server.closeAllConnections(); await new Promise((r) => server.close(r)); vi.unstubAllGlobals(); await closePool(); });

// ---- cuerpos xBRL-JSON sintéticos (forma medida en el spike)
const LEI_A = 'TESTLEI0000000000001';
const LEI_B = 'TESTLEI0000000000002';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type F = Record<string, unknown>;
// decimals: 'none' = el hecho no lo trae (un parámetro por defecto no sirve: undefined lo activaría).
const fact = (concept: string, period: string, value: string | null, extra: F = {}, decimals: unknown = -6, unit: string | null = 'iso4217:EUR'): F =>
  ({ value, ...(decimals === 'none' ? {} : { decimals }), dimensions: { concept, entity: `scheme:${LEI_A}`, period, ...(unit ? { unit } : {}), ...extra } });
const FY = '2024-01-01T00:00:00/2025-01-01T00:00:00'; // ejercicio 2024 (cierre real 2024-12-31)
const FY_PREV = '2023-01-01T00:00:00/2024-01-01T00:00:00';
const report = (facts: F[], taxonomy = 'https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full') =>
  ({ documentInfo: { documentType: 'https://xbrl.org/2021/xbrl-json', namespaces: { 'ifrs-full': taxonomy } }, facts: Object.fromEntries(facts.map((f, i) => [`f-${i + 1}`, f])) });
const annualReport = (revenue = '1000') => report([
  fact('ifrs-full:Revenue', FY, revenue), fact('ifrs-full:Revenue', FY_PREV, '900'),
  fact('ifrs-full:Assets', '2025-01-01T00:00:00', '5000'), fact('ifrs-full:Assets', '2024-01-01T00:00:00', '4800'),
  fact('acme:Ebitda', FY, '250', {}, 3),
]);
const body = (o: unknown) => Buffer.from(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------------------------- codec
describe('codec zstd', () => {
  test('ida y vuelta, y el formato dice cómo leerlo', () => {
    const raw = Buffer.from(JSON.stringify({ a: 'x'.repeat(5000) }));
    const z = compressBody(raw);
    expect(z.length).toBeLessThan(raw.length / 10);
    expect(decodeBody(z, ESEF_BODY_FORMAT).equals(raw)).toBe(true);
    expect(decodeBody(raw, 'json')).toBe(raw);
    expect(() => decodeBody(raw, 'otro')).toThrow(/body_format desconocido/);
  });
});

// ------------------------------------------------------------------------------------------------------------- extractor
describe('extractReport (xBRL-JSON sintético)', () => {
  test('solo numéricos sin dimensiones, de todos los periodos, con el cierre real (día de menos)', () => {
    const out = extractReport(report([
      fact('ifrs-full:Revenue', FY, '1000'),
      fact('ifrs-full:Revenue', FY_PREV, '900'), // comparativo: también se guarda
      fact('ifrs-full:Revenue', FY, '400', { 'ifrs-full:SegmentsAxis': 'acme:Norte' }), // con dimensión: fuera
      fact('ifrs-full:Assets', '2025-01-01T00:00:00', '5000'), // instante
      fact('ifrs-full:Equity', FY, null), // nil: fuera
      fact('acme:Texto', FY, 'hola', {}, 'none', null), // no numérico (sin unit): fuera
      fact('ifrs-full:ProfitLoss', FY, 'NaN'), // valor que no es número: fuera
    ]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const x = out.extraction;
    expect(x.facts.map((f) => [f.concept, f.periodStart, f.periodEnd, f.value])).toEqual([
      ['ifrs-full:Revenue', '2024-01-01', '2024-12-31', '1000'],
      ['ifrs-full:Revenue', '2023-01-01', '2023-12-31', '900'],
      ['ifrs-full:Assets', null, '2024-12-31', '5000'],
    ]);
    expect(x.stats).toMatchObject({ total: 7, withDimensions: 1, nonNumeric: 1, nil: 1, badValue: 1 });
    expect([x.periodStart, x.periodEnd]).toEqual(['2024-01-01', '2024-12-31']);
    expect(x.ifrsTaxonomy).toBe('2024-03-27');
  });

  test('el valor es el texto exacto (sin pasar por float) y decimals ausente o INF queda NULL; una extensión se marca', () => {
    const out = extractReport(report([
      fact('ifrs-full:Revenue', FY, '38632000000.0'),
      fact('ifrs-full:DividendsPaid', FY, '12345678901234567890.123456789', {}, 'none'),
      fact('acme:Ebitda', FY, '250', {}, 'INF'),
      fact('acme:Margen', FY, '-0.578', {}, 3, 'xbrli:pure'),
    ]));
    if (!out.ok) throw new Error('debía extraerse');
    const by = Object.fromEntries(out.extraction.facts.map((f) => [f.concept, f]));
    expect(by['ifrs-full:Revenue']).toMatchObject({ value: '38632000000.0', decimals: -6, isExtension: false });
    expect(by['ifrs-full:DividendsPaid']).toMatchObject({ value: '12345678901234567890.123456789', decimals: null });
    expect(by['acme:Ebitda']).toMatchObject({ decimals: null, isExtension: true });
    expect(by['acme:Margen']).toMatchObject({ value: '-0.578', unit: 'xbrli:pure', isExtension: true });
    expect(out.extraction.stats.decimalsInf).toBe(1);
  });

  test('ejercicio que cierra en enero y periodo principal = cierre anual más reciente', () => {
    const out = extractReport(report([
      fact('ifrs-full:Revenue', '2024-02-01T00:00:00/2025-02-01T00:00:00', '38632'),
      fact('ifrs-full:Revenue', '2023-02-01T00:00:00/2024-02-01T00:00:00', '35947'),
      fact('ifrs-full:Assets', '2025-02-01T00:00:00', '1'),
    ]));
    if (!out.ok) throw new Error('debía extraerse');
    expect([out.extraction.periodStart, out.extraction.periodEnd]).toEqual(['2024-02-01', '2025-01-31']);
  });

  test('un intermedio (trimestre) no es un informe anual, y un JSON sin facts no es xBRL-JSON', () => {
    expect(extractReport(report([fact('ifrs-full:Revenue', '2024-01-01T00:00:00/2024-04-01T00:00:00', '1'), fact('ifrs-full:Assets', '2024-04-01T00:00:00', '1')])))
      .toEqual({ ok: false, reason: 'no_annual_period' });
    expect(extractReport({ hola: 1 })).toEqual({ ok: false, reason: 'not_xbrl_json' });
  });
});

// --------------------------------------------------------------------------------------------------------------- captura
const idx = (n: string, lei: string, country: string, pe: string, over: Partial<IdxFiling> = {}): IdxFiling => ({ fxo_id: `${lei}-${pe}-ESEF-${country}-${n}`, lei, country, period_end: pe, ...over });
const serve = (f: IdxFiling, b: Buffer = body(annualReport())) => { index.push(f); if (jsonUrl(f)) files.set(jsonUrl(f)!, b); };

describe('captura del índice y por lotes', () => {
  test('índice: una raw_payload por página, crudo comprimido con zstd y hash del cuerpo sin comprimir', async () => {
    for (let i = 1; i <= 5; i++) index.push(idx('0', LEI_A, 'ES', `202${i}-12-31`));
    const s = await captureIndex({ userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {}, pages: 1 + 1 });
    expect(s).toMatchObject({ status: 'ok', ok: 2 });
    expect((await pool.query("SELECT provider, scope FROM ingestion_run WHERE ingestion_run_id = $1", [s.runId])).rows[0]).toEqual({ provider: 'esef', scope: 'index' });
    // con pages sin indicar, el sondeo lee meta.count; aquí se pasó pages para no depender de ello
    const rows = (await pool.query("SELECT rp.endpoint, rp.params, rp.http_status, rp.parse_status, rp.content_hash, b.body, b.body_format, b.size_bytes FROM raw_payload rp JOIN payload_blob b USING (content_hash) WHERE rp.ingestion_run_id = $1 ORDER BY rp.raw_payload_id", [s.runId])).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ endpoint: 'filings-index', http_status: 200, body_format: 'json+zstd', parse_status: 'ok' });
      const raw = decodeBody(r.body, r.body_format);
      expect(sha(raw)).toBe(r.content_hash); // el hash es el del cuerpo SIN comprimir
      expect(Number(r.size_bytes)).toBe(raw.length);
    }
    expect(rows[0].body.length).toBeLessThan(decodeBody(rows[0].body, rows[0].body_format).length); // la página con filings sí comprime (la vacía es demasiado pequeña)
    expect(rows.map((r) => r.params)).toEqual([{ page: '1', size: '1000' }, { page: '2', size: '1000' }]);
  });

  test('foto del índice: presentaciones con su LEI; sin json_url o sin entidad no sirven; sin foto terminada, error claro', async () => {
    await expect(readIndexPhoto()).rejects.toThrow(/No hay ninguna foto del índice/);
    index.push(idx('0', LEI_A, 'ES', '2024-12-31'), idx('0', LEI_B, 'GB', '2024-12-31', { json_url: null }));
    const s = await captureIndex({ userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
    expect(s.status).toBe('ok');
    const photo = await readIndexPhoto();
    expect(photo.runId).toBe(s.runId);
    expect(photo.filings.map((f) => [f.fxo_id, f.lei, f.country])).toEqual([[`${LEI_A}-2024-12-31-ESEF-ES-0`, LEI_A, 'ES']]);
    expect(parseIndexPages([body({ data: [{ attributes: { fxo_id: 'x', json_url: '/x' }, relationships: {} }] })]).withoutEntity).toBe(1);
  });

  const photoWith = async () => { await captureIndex({ userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} }); };

  test('lote: filtros por país, año y LEI; Ucrania, cierres anteriores a FY2021 y cierres futuros quedan fuera', async () => {
    serve(idx('0', LEI_A, 'ES', '2023-12-31')); serve(idx('0', LEI_A, 'ES', '2024-12-31')); serve(idx('0', LEI_B, 'GB', '2024-12-31'));
    serve(idx('0', LEI_B, 'UA', '2024-12-31')); serve(idx('0', LEI_A, 'ES', '2019-12-31')); serve(idx('0', LEI_A, 'ES', '2031-01-01'));
    await photoWith();
    const ids = async (f: Parameters<typeof planBatch>[0]) => (await planBatch({ today: '2026-10-20', ...f })).jobs.map((j) => j.params.fxo_id!.slice(21));
    expect(await ids({})).toEqual(['2023-12-31-ESEF-ES-0', '2024-12-31-ESEF-ES-0', '2024-12-31-ESEF-GB-0']);
    expect(await ids({ countries: ['gb'] })).toEqual(['2024-12-31-ESEF-GB-0']);
    expect(await ids({ years: ['2023'] })).toEqual(['2023-12-31-ESEF-ES-0']);
    expect(await ids({ countries: ['ES'], years: ['2024'] })).toEqual(['2024-12-31-ESEF-ES-0']);
    expect(await ids({ leis: [LEI_B] })).toEqual(['2024-12-31-ESEF-GB-0']);
    expect(await ids({ limit: 2 })).toHaveLength(2);
    // la llamada lleva en params lo que el extractor necesita del índice
    const job = (await planBatch({ today: '2026-10-20', leis: [LEI_B] })).jobs[0]!;
    expect(job).toMatchObject({ endpoint: 'filing-json', symbol: LEI_B, params: { lei: LEI_B, country: 'GB', period_end: '2024-12-31', error_count: '0' } });
  });

  test('lote: una ingestion_run por lote, crudo comprimido, User-Agent y una petición por segundo como máximo', async () => {
    serve(idx('0', LEI_A, 'ES', '2023-12-31')); serve(idx('0', LEI_A, 'ES', '2024-12-31')); serve(idx('0', LEI_B, 'ES', '2024-12-31'));
    await photoWith();
    seen.length = 0;
    const sleeps: number[] = [];
    let clock = 1_000_000;
    const s = await captureBatch({ today: '2026-10-20' }, { userAgent: UA, baseUrl: base, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock });
    expect(s).toMatchObject({ status: 'ok', ok: 3, errors: 0 });
    expect(s.plan).toMatchObject({ candidates: 3, alreadyCaptured: 0, jobs: 3 });
    expect(sleeps).toEqual([ESEF_CONFIG.minIntervalMs, ESEF_CONFIG.minIntervalMs]); // 3 llamadas, pausa de ≥1,1 s entre cada dos
    expect(seen.every((r) => r.ua === UA)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM ingestion_run WHERE provider = 'esef' AND scope = $1", [s.scope])).rows[0].n).toBe(1);
    const r = (await pool.query("SELECT rp.endpoint, rp.provider_symbol, rp.params, b.body, b.body_format, rp.content_hash FROM raw_payload rp JOIN payload_blob b USING (content_hash) WHERE rp.ingestion_run_id = $1 ORDER BY rp.raw_payload_id", [s.runId])).rows;
    expect(r.map((x) => x.endpoint)).toEqual(['filing-json', 'filing-json', 'filing-json']);
    expect(r[0]).toMatchObject({ provider_symbol: LEI_A, body_format: 'json+zstd' });
    expect(sha(decodeBody(r[0].body, r[0].body_format))).toBe(r[0].content_hash);
  });

  test('reanudable: se salta lo que ya tiene raw_payload con http 200; un corte (429) deja la corrida en partial y se retoma', async () => {
    for (const y of ['2021', '2022', '2023', '2024']) serve(idx('0', LEI_A, 'ES', `${y}-12-31`));
    await photoWith();
    status.set(`/${LEI_A}/2023-12-31/${LEI_A}-2023-12-31-ESEF-ES-0.json`, 429);
    const first = await captureBatch({ today: '2026-10-20' }, { userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
    expect(first).toMatchObject({ status: 'partial', stoppedBy: 'rate_limit', ok: 2, errors: 1 });
    expect((await pool.query("SELECT status FROM ingestion_run WHERE ingestion_run_id = $1", [first.runId])).rows[0].status).toBe('partial');
    status.clear();
    seen.length = 0;
    const second = await captureBatch({ today: '2026-10-20' }, { userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
    expect(second.plan).toMatchObject({ candidates: 4, alreadyCaptured: 2, jobs: 2 });
    expect(second).toMatchObject({ status: 'ok', ok: 2 });
    expect(seen.map((r) => r.path)).toEqual([2023, 2024].map((y) => `/${LEI_A}/${y}-12-31/${LEI_A}-${y}-12-31-ESEF-ES-0.json`));
    const third = await captureBatch({ today: '2026-10-20' }, { userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
    expect(third.plan.jobs).toBe(0);
    expect(third.status).toBe('ok');
  });

  test('una señal de corte para antes de la siguiente llamada y deja la corrida cerrada', async () => {
    for (const y of ['2021', '2022', '2023']) serve(idx('0', LEI_A, 'ES', `${y}-12-31`));
    await photoWith();
    const ac = new AbortController();
    let calls = 0;
    // now fijo a 0: cada llamada pasa por la pausa; se corta durante la segunda, así que la tercera ya no se hace.
    const s = await captureBatch({ today: '2026-10-20' }, { userAgent: UA, baseUrl: base, minIntervalMs: 100, now: () => 0, sleep: async () => { calls++; if (calls === 2) ac.abort(); }, signal: ac.signal });
    expect(s).toMatchObject({ status: 'partial', stoppedBy: 'abort', ok: 2 });
    expect((await pool.query("SELECT status, finished_at IS NOT NULL AS done FROM ingestion_run WHERE ingestion_run_id = $1", [s.runId])).rows[0]).toEqual({ status: 'partial', done: true });
  });

  test('replay no toca las corridas de ESEF (sus cuerpos van comprimidos)', async () => {
    serve(idx('0', LEI_A, 'ES', '2024-12-31'));
    await photoWith();
    await captureBatch({ today: '2026-10-20' }, { userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
    expect((await replay()).checked).toBe(0);
    expect((await pool.query("SELECT parse_status FROM raw_payload rp JOIN ingestion_run r USING (ingestion_run_id) WHERE r.provider = 'esef' AND rp.endpoint = 'filing-json'")).rows[0].parse_status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------------------------------------- extractor en BD
describe('extractAll (crudo -> esef_filing + esef_fact)', () => {
  const captureAll = async () => {
    await captureIndex({ userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
    return captureBatch({ today: '2026-10-20' }, { userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
  };
  const snapshot = async () => ({
    filings: (await pool.query('SELECT fxo_id, content_hash, lei, country, period_start::text, period_end::text, index_period_end::text, processed_at, error_count, ifrs_taxonomy, extractor_version FROM esef_filing ORDER BY fxo_id')).rows,
    facts: (await pool.query('SELECT f.fxo_id, x.concept, x.is_extension, x.period_start::text, x.period_end::text, x.value::text, x.decimals, x.unit, x.extractor_version FROM esef_fact x JOIN esef_filing f USING (esef_filing_id) ORDER BY f.fxo_id, x.esef_fact_id')).rows,
  });

  test('escribe el informe anual con su cierre real, los datos del índice y solo los hechos numéricos sin dimensiones', async () => {
    serve(idx('0', LEI_A, 'ES', '2024-12-31', { error_count: 2, processed: '2024-05-06 07:08:09.123456' }));
    const run = await captureAll();
    const s = await extractAll();
    expect(s).toMatchObject({ checked: 1, filings: 1, facts: 5, skippedNotAnnual: 0, error: 0 });
    const f = (await pool.query("SELECT esef_filing_id AS id, fxo_id, lei, country, period_start::text AS ps, period_end::text AS pe, index_period_end::text AS ipe, processed_at, error_count, ifrs_taxonomy, extractor_version, content_hash FROM esef_filing")).rows[0];
    expect(f).toMatchObject({ fxo_id: `${LEI_A}-2024-12-31-ESEF-ES-0`, lei: LEI_A, country: 'ES', ps: '2024-01-01', pe: '2024-12-31', ipe: '2024-12-31', error_count: 2, ifrs_taxonomy: '2024-03-27', extractor_version: ESEF_CONFIG.extractorVersion });
    expect(f.processed_at.toISOString()).toBe('2024-05-06T07:08:09.123Z');
    expect((await pool.query('SELECT content_hash FROM raw_payload WHERE ingestion_run_id = $1', [run.runId])).rows[0].content_hash).toBe(f.content_hash);
    expect((await pool.query('SELECT concept, period_end::text AS pe, value::text AS v, is_extension AS ext FROM esef_fact WHERE esef_filing_id = $1 ORDER BY esef_fact_id', [f.id])).rows).toEqual([
      { concept: 'ifrs-full:Revenue', pe: '2024-12-31', v: '1000', ext: false }, { concept: 'ifrs-full:Revenue', pe: '2023-12-31', v: '900', ext: false },
      { concept: 'ifrs-full:Assets', pe: '2024-12-31', v: '5000', ext: false }, { concept: 'ifrs-full:Assets', pe: '2023-12-31', v: '4800', ext: false },
      { concept: 'acme:Ebitda', pe: '2024-12-31', v: '250', ext: true },
    ]);
    expect((await pool.query("SELECT parse_status FROM raw_payload WHERE endpoint = 'filing-json'")).rows[0].parse_status).toBe('ok');
  });

  test('regenerable: vaciar esef_fact y esef_filing y repetir con --all da exactamente lo mismo; sin --all no hay nada pendiente', async () => {
    serve(idx('0', LEI_A, 'ES', '2024-12-31')); serve(idx('1', LEI_A, 'GB', '2024-12-31'), body(annualReport('1001'))); serve(idx('0', LEI_B, 'ES', '2023-12-31'));
    await captureAll();
    await extractAll();
    const before = await snapshot();
    expect(before.filings).toHaveLength(3);
    expect((await extractAll()).checked).toBe(0);
    await pool.query('DELETE FROM esef_fact'); await pool.query('DELETE FROM esef_filing');
    expect((await extractAll({ all: true })).filings).toBe(3);
    expect(await snapshot()).toEqual(before);
    expect((await extractAll({ all: true })).filings).toBe(3); // idempotente sobre lo ya escrito
    expect(await snapshot()).toEqual(before);
  });

  test('un intermedio no crea esef_filing (queda solo el crudo); un hash alterado o un identificador que no es LEI dan error en la raw_payload', async () => {
    serve(idx('0', LEI_A, 'ES', '2024-12-31'), body(report([fact('ifrs-full:Revenue', '2024-01-01T00:00:00/2024-04-01T00:00:00', '1')])));
    serve(idx('0', LEI_B, 'ES', '2024-12-31'));
    index.push(idx('0', 'ABC', 'ES', '2024-12-31')); files.set(jsonUrl(index.at(-1)!)!, body(annualReport()));
    await captureAll();
    const s = await extractAll();
    expect(s).toMatchObject({ checked: 3, filings: 1, skippedNotAnnual: 1, error: 1 });
    expect((await pool.query('SELECT lei FROM esef_filing')).rows).toEqual([{ lei: LEI_B }]);
    expect((await pool.query("SELECT params->>'lei' AS lei, parse_status, parse_error FROM raw_payload WHERE endpoint = 'filing-json' AND parse_status = 'error'")).rows).toEqual([{ lei: 'ABC', parse_status: 'error', parse_error: 'el identificador de la entidad no es un LEI: ABC' }]);
    // un blob con el cuerpo cambiado ya no coincide con su hash
    await pool.query("UPDATE payload_blob SET body = $1 WHERE content_hash = (SELECT content_hash FROM raw_payload WHERE params->>'lei' = $2)", [compressBody(Buffer.from('{"facts":{}}')), LEI_B]);
    const t = await extractAll({ all: true });
    expect(t.error).toBe(2);
    expect((await pool.query("SELECT parse_error FROM raw_payload WHERE params->>'lei' = $1", [LEI_B])).rows[0].parse_error).toMatch(/hash/);
  });
});

// ------------------------------------------------------------------------- deduplicación por (LEI, cierre real) en dos lotes
describe('presentación elegida por (LEI, cierre real): se calcula sobre todo lo capturado, no dentro del lote', () => {
  test('capturar en un segundo lote otra versión del mismo informe cambia la elegida sin tocar nada más', async () => {
    // Mismo informe (LEI_A, cierre 2024-12-31) en dos presentaciones; el índice da a la segunda menos errores.
    serve(idx('0', LEI_A, 'ES', '2024-12-31', { error_count: 3, processed: '2024-01-01 10:00:00.000000' }));
    serve(idx('1', LEI_A, 'GB', '2024-12-31', { error_count: 0, processed: '2024-01-01 09:00:00.000000' }), body(annualReport('1001')));
    serve(idx('0', LEI_B, 'ES', '2024-12-31'));
    await captureIndex({ userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
    const opts = { userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} };
    await captureBatch({ countries: ['ES'], today: '2026-10-20' }, opts); // lote 1: solo ES (la presentación -0 de A y la de B)
    await extractAll();
    const chosen1 = await chosenFilings(pool);
    expect(chosen1.map((c) => c.fxo_id)).toEqual([`${LEI_A}-2024-12-31-ESEF-ES-0`, `${LEI_B}-2024-12-31-ESEF-ES-0`]);
    const row = async (fxo: string) => (await pool.query('SELECT to_jsonb(f) AS f, (SELECT count(*)::int FROM esef_fact x WHERE x.esef_filing_id = f.esef_filing_id) AS n FROM esef_filing f WHERE fxo_id = $1', [fxo])).rows[0];
    const aBefore = await row(`${LEI_A}-2024-12-31-ESEF-ES-0`);
    const bBefore = await row(`${LEI_B}-2024-12-31-ESEF-ES-0`);

    await captureBatch({ countries: ['GB'], today: '2026-10-20' }, opts); // lote 2: la otra versión (GB, sin errores)
    await extractAll();
    const chosen2 = await chosenFilings(pool);
    expect(chosen2.map((c) => c.fxo_id)).toEqual([`${LEI_A}-2024-12-31-ESEF-GB-1`, `${LEI_B}-2024-12-31-ESEF-ES-0`]); // cambió la de A
    expect(await row(`${LEI_A}-2024-12-31-ESEF-ES-0`)).toEqual(aBefore); // la anterior sigue ahí, intacta
    expect(await row(`${LEI_B}-2024-12-31-ESEF-ES-0`)).toEqual(bBefore); // y la otra empresa, también
    expect((await pool.query('SELECT count(*)::int AS n FROM esef_filing')).rows[0].n).toBe(3); // se guardan todas las presentaciones
    expect((await pool.query('SELECT count(*)::int AS n FROM ingestion_run WHERE provider = $1 AND scope LIKE $2', ['esef', 'batch:%'])).rows[0].n).toBe(2);
    // ni la elegida ni el criterio se guardan en ninguna columna
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'esef_filing' AND column_name ~ 'chosen|elegid|selected'")).rows).toEqual([]);
  });

  test('desempate: a igualdad de errores gana la procesada más reciente, y luego el fxo_id mayor', async () => {
    const mk = async (rows: { fxo: string; err: number | null; at: string | null }[]) => {
      await pool.query('DELETE FROM esef_fact'); await pool.query('DELETE FROM esef_filing');
      await pool.query("INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1, '\\x7b7d', 2) ON CONFLICT DO NOTHING", ['0'.repeat(64)]);
      for (const r of rows) await pool.query("INSERT INTO esef_filing (fxo_id, content_hash, lei, period_start, period_end, error_count, processed_at, extractor_version) VALUES ($1, $2, $3, '2024-01-01', '2024-12-31', $4, $5, 'x')", [r.fxo, '0'.repeat(64), LEI_A, r.err, r.at]);
      return (await chosenFilings(pool)).map((c) => c.fxo_id);
    };
    expect(await mk([{ fxo: 'a', err: 1, at: '2024-01-02' }, { fxo: 'b', err: 0, at: '2024-01-01' }])).toEqual(['b']);
    expect(await mk([{ fxo: 'a', err: 0, at: '2024-01-01' }, { fxo: 'b', err: 0, at: '2024-01-02' }])).toEqual(['b']);
    expect(await mk([{ fxo: 'a', err: 0, at: '2024-01-01' }, { fxo: 'b', err: 0, at: '2024-01-01' }])).toEqual(['b']);
    expect(await mk([{ fxo: 'a', err: null, at: null }, { fxo: 'b', err: 5, at: null }])).toEqual(['b']); // sin dato de errores pierde ante cualquier recuento
    await pool.query('DELETE FROM esef_filing'); await pool.query('DELETE FROM payload_blob');
  });
});

// ----------------------------------------------------------------------------------------- muestra real (fixtures/esef/)
const FIX = 'fixtures/esef';
const haveFixtures = existsSync(`${FIX}/filings/p1000-001.json`) && existsSync(`${FIX}/q23.json`) && existsSync(`${FIX}/json`);
describe.skipIf(!haveFixtures)('muestra real: las 16 empresas del spike, con los payloads de fixtures/esef/ (no se suben)', () => {
  const have = haveFixtures ? new Set(readdirSync(`${FIX}/json`).map((f) => f.replace(/\.json$/, ''))) : new Set<string>();

  // Reconstruye del índice real descargado en el spike solo las presentaciones de las que hay payload en disco.
  function realIndex(): IdxFiling[] {
    const out: IdxFiling[] = [];
    for (const f of readdirSync(`${FIX}/filings`).filter((x) => x.startsWith('p1000-')).sort()) {
      const j = JSON.parse(readFileSync(`${FIX}/filings/${f}`, 'utf8'));
      const lei = new Map<string, string>(j.included.map((e: any) => [e.id, e.attributes.identifier]));
      for (const d of j.data) {
        if (!have.has(d.attributes.fxo_id)) continue;
        const a = d.attributes;
        out.push({ fxo_id: a.fxo_id, lei: lei.get(d.relationships.entity.data.id)!, country: a.country, period_end: a.period_end, error_count: a.error_count, processed: a.processed, json_url: a.json_url });
      }
    }
    return out;
  }

  test('captura por lotes, extracción y comprobación contra lo medido en el spike (q23.json)', async () => {
    index = realIndex();
    expect(index.length).toBe(have.size);
    const byUrl = new Map(index.map((f) => [f.json_url, f]));
    const realServe = http.createServer((req, res) => {
      const f = byUrl.get(new URL(req.url!, 'http://x').pathname);
      if (!f) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200); res.end(readFileSync(`${FIX}/json/${f.fxo_id}.json`));
    });
    await new Promise<void>((r) => realServe.listen(0, '127.0.0.1', r));
    const realBase = `http://127.0.0.1:${(realServe.address() as AddressInfo).port}`;
    try {
      // el índice lo sirve el servidor general (index), los informes el de ficheros
      await captureIndex({ userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
      const photo = await readIndexPhoto();
      const lotes = [
        await captureBatch({ countries: ['ES', 'FR', 'IT'], today: '2026-10-20' }, { userAgent: UA, baseUrl: realBase, minIntervalMs: 0, sleep: async () => {}, photo }),
        await captureBatch({ today: '2026-10-20' }, { userAgent: UA, baseUrl: realBase, minIntervalMs: 0, sleep: async () => {}, photo }),
      ];
      expect(lotes.map((l) => l.status)).toEqual(['ok', 'ok']);
      expect(lotes[0]!.ok + lotes[1]!.ok).toBe(have.size);
      const s = await extractAll();
      expect(s.error).toBe(0);
      expect(s.filings + s.skippedNotAnnual).toBe(have.size);
      // contra el spike: cierre real y recuento de hechos (el spike contaba también los nil, que aquí no se guardan)
      const q = JSON.parse(readFileSync(`${FIX}/q23.json`, 'utf8')) as { fxo: string; mainEnd: string; numericNondim: number }[];
      const rows = (await pool.query('SELECT f.fxo_id, f.period_end::text AS pe, count(x.*)::int AS n FROM esef_filing f LEFT JOIN esef_fact x USING (esef_filing_id) GROUP BY f.esef_filing_id')).rows;
      const got = new Map(rows.map((r) => [r.fxo_id, r]));
      let compared = 0;
      for (const e of q) {
        const g = got.get(e.fxo);
        expect(g, e.fxo).toBeDefined();
        expect(g.pe, e.fxo).toBe(e.mainEnd);
        const nil = Object.values(JSON.parse(readFileSync(`${FIX}/json/${e.fxo}.json`, 'utf8')).facts as Record<string, any>).filter((x) => x.value === null && x.dimensions.unit && Object.keys(x.dimensions).every((k) => ['concept', 'entity', 'period', 'unit', 'language'].includes(k))).length;
        expect(g.n, e.fxo).toBe(e.numericNondim - nil);
        compared++;
      }
      expect(compared).toBe(q.length);
      // 16 empresas distintas en la muestra
      expect(new Set(rows.map((r) => r.fxo_id.slice(0, 20))).size).toBe(16);
    } finally {
      realServe.closeAllConnections();
      await new Promise((r) => realServe.close(r));
    }
  }, 300_000);

  test('Volvo 2021 en dos lotes con --limit: la versión -1 (sueco) llega en el segundo y pasa a ser la elegida sin tocar la -0 (inglés)', async () => {
    const volvo = '549300HGV012CNC8JD22';
    const only = realIndex().filter((f) => f.lei === volvo && f.period_end === '2021-12-31');
    expect(only.map((f) => f.fxo_id)).toEqual([`${volvo}-2021-12-31-ESEF-SE-0`, `${volvo}-2021-12-31-ESEF-SE-1`]);
    index = only;
    for (const f of only) files.set(f.json_url!, readFileSync(`${FIX}/json/${f.fxo_id}.json`));
    await captureIndex({ userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} });
    const opts = { userAgent: UA, baseUrl: base, minIntervalMs: 0, sleep: async () => {} };
    expect((await captureBatch({ leis: [volvo], limit: 1, today: '2026-10-20' }, opts)).ok).toBe(1);
    await extractAll();
    expect((await chosenFilings(pool)).map((c) => c.fxo_id)).toEqual([`${volvo}-2021-12-31-ESEF-SE-0`]);
    const before = (await pool.query('SELECT to_jsonb(f) AS f FROM esef_filing f')).rows;
    expect((await captureBatch({ leis: [volvo], limit: 1, today: '2026-10-20' }, opts)).ok).toBe(1); // reanuda: salta la -0, baja la -1
    await extractAll();
    expect((await chosenFilings(pool)).map((c) => c.fxo_id)).toEqual([`${volvo}-2021-12-31-ESEF-SE-1`]);
    const after = (await pool.query("SELECT to_jsonb(f) AS f FROM esef_filing f WHERE fxo_id LIKE '%-SE-0'")).rows;
    expect(after).toEqual(before);
    // mismos números en las dos lenguas: lo que cambia es el idioma, no los hechos
    const sums = (await pool.query("SELECT f.fxo_id, count(*)::int AS n, sum(x.value) AS s FROM esef_filing f JOIN esef_fact x USING (esef_filing_id) GROUP BY f.fxo_id ORDER BY 1")).rows;
    expect(sums[0].n).toBe(sums[1].n);
    expect(sums[0].s).toBe(sums[1].s);
  }, 120_000);
});
