import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { captureSec, requireSecUserAgent, secJobs } from '../src/sec/client.js';
import { findFact, withinTolerance } from '../src/sec/facts.js';
import { runValidation } from '../src/validation/runner.js';

// SEC companyfacts: captura contra un servidor local (estos tests NO llaman a la SEC) y cross-check de FUNDAMENTALS con cuerpos
// sintéticos que siguen la forma documentada de la API XBRL (sin payload real: falta un SEC_USER_AGENT con contacto real).
const realFetch = globalThis.fetch;
const UA = 'Second hero pruebas contacto@dominio-de-prueba.test';
const seen: { path: string; ua: string | null; at: number }[] = [];
let server: http.Server;
let base = '';
let facts = new Map<string, unknown>(); // CIK de 10 dígitos -> cuerpo

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
    const m = /^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(req.url!);
    const body = m ? facts.get(m[1]!) : undefined;
    if (body === undefined) { res.writeHead(404); res.end('{"error":"no encontrado"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
async function cleanAll() {
  for (const sql of [
    'DELETE FROM data_quality_finding', 'DELETE FROM fundamentals', 'DELETE FROM listing', 'DELETE FROM security', 'DELETE FROM company',
    'DELETE FROM raw_payload', 'DELETE FROM payload_blob', 'DELETE FROM ingestion_run',
    "DELETE FROM dimension_audit WHERE table_name IN ('company', 'security', 'listing')",
  ]) await pool.query(sql);
}
beforeEach(async () => { seen.length = 0; facts = new Map(); await cleanAll(); });
afterAll(async () => { await cleanAll(); server.closeAllConnections(); await new Promise((r) => server.close(r)); vi.unstubAllGlobals(); await closePool(); });

// ---- cuerpos de companyfacts
type Entry = { start?: string; end: string; val: number; accn: string; fy: number; fp: string; form: string; filed: string };
const body = (tags: Record<string, Entry[]>) => ({ cik: 1, entityName: 'Prueba', facts: { 'us-gaap': Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, { label: k, units: { USD: v } }])) } });
const annual = (end: string, val: number, over: Partial<Entry> = {}): Entry => ({ start: '2024-10-01', end, val, accn: '0000000001-25-000001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', ...over });
const quarter = (end: string, val: number, over: Partial<Entry> = {}): Entry => ({ start: '2025-04-01', end, val, accn: '0000000001-25-000002', fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', ...over });
const instant = (end: string, val: number, over: Partial<Entry> = {}): Entry => ({ end, val, accn: '0000000001-25-000001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', ...over });

async function makeCompany(cik: string) {
  const company = (await pool.query<{ id: string }>("INSERT INTO company (legal_name, cik, identity_source) VALUES ($1, $2, 'cik') RETURNING company_id AS id", [`Empresa ${cik}`, cik])).rows[0]!.id;
  return company;
}
async function fund(company: string, periodEnd: string, type: 'A' | 'Q', v: { revenue?: string; net_income?: string; total_assets?: string }, over: { currency?: string; source?: string; reportedAt?: string } = {}) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, reported_at_source, currency, revenue, net_income, total_assets)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING fundamentals_id AS id`,
    [company, periodEnd, type, over.reportedAt ?? periodEnd, over.source ?? 'provider', over.currency ?? 'USD', v.revenue ?? null, v.net_income ?? null, v.total_assets ?? null])).rows[0]!.id;
}
const row = async (id: string) => (await pool.query('SELECT reported_at_source AS src, cross_checked_at FROM fundamentals WHERE fundamentals_id = $1', [id])).rows[0]!;
const findings = async () => (await pool.query("SELECT target_key, severity, status, detail FROM data_quality_finding WHERE rule_code = 'SECOND_SOURCE_MISMATCH' ORDER BY finding_id")).rows;

// Guarda un companyfacts como lo haría la captura (provider 'sec'), sin pasar por red.
async function storeFacts(cik: string, json: unknown, over: { status?: number; fetchedAt?: string } = {}) {
  const bytes = Buffer.from(JSON.stringify(json));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query('INSERT INTO payload_blob (content_hash, body, size_bytes) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [hash, bytes, bytes.length]);
  const run = (await pool.query<{ id: string }>("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('sec', 'test:companyfacts', 'ok', now()) RETURNING ingestion_run_id AS id")).rows[0]!.id;
  await pool.query("INSERT INTO raw_payload (ingestion_run_id, endpoint, provider_symbol, params, http_status, content_hash, fetched_at) VALUES ($1,'companyfacts/{cik}',$2,$3::jsonb,$4,$5,$6)",
    [run, cik, JSON.stringify({ cik }), over.status ?? 200, hash, over.fetchedAt ?? '2026-10-13T10:00:00Z']);
}

describe('captura de la SEC', () => {
  test('se niega a llamar sin SEC_USER_AGENT real (vacío o el valor de ejemplo de .env.example) y no hace ninguna llamada', async () => {
    for (const ua of ['', '   ', 'Second hero tu-email@ejemplo.com', '"Second hero tu-email@ejemplo.com"']) {
      await expect(captureSec(['0000320193'], { userAgent: ua, baseUrl: base, scope: 'test:sec' })).rejects.toThrow(/SEC_USER_AGENT/);
    }
    expect(seen).toHaveLength(0);
    expect(requireSecUserAgent(`"${UA}"`)).toBe(UA);
  });

  test('una llamada por CIK (10 dígitos), con User-Agent, sin token, como provider "sec", y con pausa mínima entre llamadas', async () => {
    facts.set('0000320193', body({ Assets: [instant('2025-09-27', 1)] }));
    facts.set('0001318605', body({ Assets: [instant('2025-12-31', 2)] }));
    const s = await captureSec(['320193', '0001318605', '0000320193'], { userAgent: UA, baseUrl: base, scope: 'test:sec', minIntervalMs: 60 });
    expect(s).toMatchObject({ status: 'ok', ok: 2, errors: 0, jobsDone: 2 }); // el CIK repetido se pide una vez
    expect(seen.map((x) => x.path)).toEqual(['/api/xbrl/companyfacts/CIK0000320193.json', '/api/xbrl/companyfacts/CIK0001318605.json']);
    expect(seen.every((x) => x.ua === UA)).toBe(true);
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(45);
    const run = (await pool.query('SELECT provider, scope, status, req_count FROM ingestion_run WHERE ingestion_run_id = $1', [s.runId])).rows[0];
    expect(run).toEqual({ provider: 'sec', scope: 'test:sec', status: 'ok', req_count: 2 });
    const raws = (await pool.query('SELECT endpoint, provider_symbol, params, http_status FROM raw_payload WHERE ingestion_run_id = $1 ORDER BY raw_payload_id', [s.runId])).rows;
    expect(raws).toEqual([
      { endpoint: 'companyfacts/{cik}', provider_symbol: '0000320193', params: { cik: '0000320193' }, http_status: 200 },
      { endpoint: 'companyfacts/{cik}', provider_symbol: '0001318605', params: { cik: '0001318605' }, http_status: 200 },
    ]);
    expect(JSON.stringify(raws)).not.toMatch(/token/i);
  });

  test('un CIK que la SEC no conoce deja su 404 como respuesta y no tumba la corrida', async () => {
    facts.set('0000320193', body({ Assets: [instant('2025-09-27', 1)] }));
    const s = await captureSec(['0000320193', '0009999999'], { userAgent: UA, baseUrl: base, scope: 'test:sec', minIntervalMs: 0 });
    expect(s).toMatchObject({ status: 'partial', ok: 1, errors: 1, jobsDone: 2 });
  });

  test('secJobs normaliza y quita repetidos', () => {
    expect(secJobs(['320193', '0000320193', 'CIK0001318605']).map((j) => j.symbol)).toEqual(['0000320193', '0001318605']);
  });
});

describe('lectura de companyfacts', () => {
  test('anual = 10-K de unos 12 meses; trimestral = 10-Q de unos 3 meses; las de fecha (activo) solo por fecha y formulario', () => {
    const b = body({
      Revenues: [annual('2025-09-27', 400), quarter('2025-09-27', 90, { form: '10-K' }), quarter('2025-06-28', 80), annual('2025-06-28', 1, { form: '10-Q' })],
      Assets: [instant('2025-09-27', 500), instant('2025-06-28', 450, { form: '10-Q', fp: 'Q3' })],
    });
    expect(findFact(b, 'revenue', '2025-09-27', 'A')).toMatchObject({ value: '400', form: '10-K', tag: 'Revenues' });
    expect(findFact(b, 'revenue', '2025-06-28', 'Q')).toMatchObject({ value: '80', form: '10-Q' });
    expect(findFact(b, 'revenue', '2025-09-27', 'Q')).toBeNull(); // el trimestre de cierre de año va en el 10-K, no en un 10-Q
    expect(findFact(b, 'total_assets', '2025-09-27', 'A')).toMatchObject({ value: '500' });
    expect(findFact(b, 'total_assets', '2025-06-28', 'Q')).toMatchObject({ value: '450' });
    expect(findFact(b, 'net_income', '2025-09-27', 'A')).toBeNull();
  });

  test('varias entradas del mismo cierre: la presentada más tarde; la etiqueta se elige por orden de preferencia', () => {
    const b = body({
      SalesRevenueNet: [annual('2025-09-27', 111)],
      RevenueFromContractWithCustomerExcludingAssessedTax: [annual('2025-09-27', 400, { filed: '2025-10-31' }), annual('2025-09-27', 405, { filed: '2026-10-30', accn: 'x' })],
    });
    expect(findFact(b, 'revenue', '2025-09-27', 'A')).toMatchObject({ value: '405', tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', accn: 'x' });
  });

  test('cuerpos que no siguen la forma esperada se tratan como ausentes', () => {
    for (const b of [null, {}, { facts: {} }, { facts: { 'us-gaap': { Assets: { units: { EUR: [] } } } } }, [] as unknown]) expect(findFact(b, 'total_assets', '2025-09-27', 'A')).toBeNull();
  });

  test('tolerancia relativa a la cifra de la SEC', () => {
    expect(withinTolerance('1000', '1004', 0.005)).toBe(true);
    expect(withinTolerance('1000', '1006', 0.005)).toBe(false);
    expect(withinTolerance('0', '0', 0.005)).toBe(true);
    expect(withinTolerance('1', '0', 0.005)).toBe(false);
  });
});

describe('SECOND_SOURCE_MISMATCH', () => {
  const run = () => runValidation({ today: '2026-10-13', only: ['SECOND_SOURCE_MISMATCH'] });

  test('dentro de tolerancia: cross_checked + cross_checked_at (una vez); repetir no cambia nada', async () => {
    const co = await makeCompany('0000000101');
    const a = await fund(co, '2025-09-27', 'A', { revenue: '400', net_income: '100', total_assets: '1000' });
    const q = await fund(co, '2025-06-28', 'Q', { revenue: '80', net_income: '20' });
    await storeFacts('0000000101', body({
      Revenues: [annual('2025-09-27', 401), quarter('2025-06-28', 80)], NetIncomeLoss: [annual('2025-09-27', 100), quarter('2025-06-28', 20)], Assets: [instant('2025-09-27', 1000)],
    }));
    const s = await run();
    expect(s.ran.SECOND_SOURCE_MISMATCH).toMatchObject({ rows: 2, compared: 2, crossChecked: 2, mismatched: 0, candidates: 0 }); // 401 frente a 400 = 0,25 %
    const first = await row(a);
    expect(first.src).toBe('cross_checked');
    expect(first.cross_checked_at).toBeInstanceOf(Date);
    expect((await row(q)).src).toBe('cross_checked');
    const again = await run();
    expect(again.ran.SECOND_SOURCE_MISMATCH).toMatchObject({ crossChecked: 0, compared: 2 });
    expect((await row(a)).cross_checked_at).toEqual(first.cross_checked_at); // el sello no se mueve
    expect(await findings()).toHaveLength(0);
  });

  test('fila manipulada: fuera de tolerancia genera el finding con ambos valores y NO toca reported_at_source; validar dos veces no duplica', async () => {
    const co = await makeCompany('0000000102');
    const a = await fund(co, '2025-09-27', 'A', { revenue: '480', net_income: '100', total_assets: '1000' }); // ingresos manipulados: 480 frente a 400
    await storeFacts('0000000102', body({ Revenues: [annual('2025-09-27', 400, { accn: '0000000102-25-000009', filed: '2025-10-30' })], NetIncomeLoss: [annual('2025-09-27', 100)], Assets: [instant('2025-09-27', 1000)] }));
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ compared: 1, mismatched: 1, crossChecked: 0, inserted: 1 });
    expect((await row(a)).src).toBe('provider');
    expect(await findings()).toEqual([{ target_key: { fundamentals_id: Number(a) }, severity: 'warning', status: 'open', detail: {
      kind: 'value', period_end: '2025-09-27', period_type: 'A', tolerance: 0.005,
      mismatches: [{ metric: 'revenue', kind: 'value', provider: '480', sec: '400', sec_tag: 'Revenues', sec_end: '2025-09-27', sec_form: '10-K', sec_filed: '2025-10-30', sec_accn: '0000000102-25-000009' }] } }]);
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ mismatched: 1, inserted: 0, updated: 0, unchanged: 1 });
    expect(await findings()).toHaveLength(1);
    // aceptado: no se re-emite mientras el detail sea el mismo
    await pool.query("UPDATE data_quality_finding SET status = 'accepted', resolved_at = now(), resolved_by = 'david'");
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ suppressed: 1, inserted: 0 });
  });

  test('el dato se corrige y ahora cuadra: la pasada parcial deja el finding abierto; la completa lo cierra como dismissed por el runner', async () => {
    const co = await makeCompany('0000000104');
    const a = await fund(co, '2025-09-27', 'A', { revenue: '480', net_income: '100', total_assets: '1000' });
    await storeFacts('0000000104', body({ Revenues: [annual('2025-09-27', 400)], NetIncomeLoss: [annual('2025-09-27', 100)], Assets: [instant('2025-09-27', 1000)] }));
    await run();
    expect((await findings())[0]).toMatchObject({ status: 'open' });
    await pool.query('UPDATE fundamentals SET revenue = 400 WHERE fundamentals_id = $1', [a]);
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ closed: 0, crossChecked: 1 });
    expect((await findings())[0]).toMatchObject({ status: 'open' });
    expect((await runValidation({ today: '2026-10-13' })).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ closed: 1 });
    expect((await pool.query("SELECT status, resolved_by FROM data_quality_finding WHERE rule_code = 'SECOND_SOURCE_MISMATCH'")).rows).toEqual([{ status: 'dismissed', resolved_by: 'runner' }]);
  });

  test('el cierre de EODHD (fin de mes) y el de la SEC (52/53 semanas) pueden diferir unos días; más de la ventana no se compara', async () => {
    const co = await makeCompany('0000000105');
    const near = await fund(co, '2025-09-30', 'A', { revenue: '400', net_income: '100', total_assets: '1000' }); // la SEC cierra el 09-27
    const far = await fund(co, '2024-09-30', 'A', { revenue: '300' }); // la SEC cierra el 09-21: 9 días, fuera de la ventana
    await storeFacts('0000000105', body({
      Revenues: [annual('2025-09-27', 400), annual('2024-09-21', 300, { start: '2023-09-24' })], NetIncomeLoss: [annual('2025-09-27', 100)], Assets: [instant('2025-09-27', 1000)],
    }));
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ compared: 1, crossChecked: 1, noFacts: 1 });
    expect((await row(near)).src).toBe('cross_checked');
    expect((await row(far)).src).toBe('provider');
  });

  test('beneficio: solo cuenta el atribuible (NetIncomeLoss); si la fila coincide solo con el consolidado (ProfitLoss) es un mismatch kind "consolidated" y no cross_checked', async () => {
    const co = await makeCompany('0000000106');
    const attributable = await fund(co, '2025-09-27', 'A', { net_income: '100' });
    const consolidated = await fund(co, '2024-09-27', 'A', { net_income: '110' });
    const neither = await fund(co, '2023-09-27', 'A', { net_income: '200' });
    await storeFacts('0000000106', body({
      NetIncomeLoss: [annual('2025-09-27', 100), annual('2024-09-27', 100, { start: '2023-10-01' }), annual('2023-09-27', 100, { start: '2022-10-01' })],
      ProfitLoss: [annual('2025-09-27', 105), annual('2024-09-27', 110, { start: '2023-10-01' }), annual('2023-09-27', 110, { start: '2022-10-01' })],
    }));
    await run();
    expect((await row(attributable)).src).toBe('cross_checked');
    expect((await row(consolidated)).src).toBe('provider');
    expect((await row(neither)).src).toBe('provider');
    const f = await findings();
    expect(f).toHaveLength(2);
    const byId = (id: string) => f.find((x) => x.target_key.fundamentals_id === Number(id))!;
    expect(byId(consolidated).detail).toMatchObject({ kind: 'consolidated', mismatches: [{ metric: 'net_income', kind: 'consolidated', provider: '110', sec_tag: 'NetIncomeLoss', sec: '100', sec_other_tags: [{ tag: 'ProfitLoss', value: '110' }] }] });
    expect(byId(neither).detail).toMatchObject({ kind: 'value', mismatches: [{ kind: 'value' }] });
    // validar otra vez: ni duplicados ni cambios
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(await findings()).toHaveLength(2);
  });

  test('beneficio: si la SEC solo trae el consolidado no hay con qué comparar y la fila no se marca', async () => {
    const co = await makeCompany('0000000107');
    const a = await fund(co, '2025-09-27', 'A', { net_income: '105' });
    await storeFacts('0000000107', body({ ProfitLoss: [annual('2025-09-27', 105)] }));
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ compared: 0, noFacts: 1, crossChecked: 0 });
    expect((await row(a)).src).toBe('provider');
    expect(await findings()).toHaveLength(0);
  });

  test('se compara con la presentación cuyo filed está más cerca del reported_at de la fila (la original), no con la reexpresada más reciente', async () => {
    const co = await makeCompany('0000000108');
    const a = await fund(co, '2025-09-27', 'A', { total_assets: '1000' }, { reportedAt: '2025-10-31' });
    await storeFacts('0000000108', body({ Assets: [
      instant('2025-09-27', 1000, { accn: 'original', filed: '2025-10-30' }),
      instant('2025-09-27', 900, { accn: 'reexpresada', form: '10-K', filed: '2027-10-29' }), // 10-K posterior con la cifra reexpresada
    ] }));
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ compared: 1, crossChecked: 1, mismatched: 0 });
    expect((await row(a)).src).toBe('cross_checked');
    // la fila de una versión posterior (reported_at cerca de la reexpresión) se compara con la reexpresada
    const b = await fund(co, '2025-09-27', 'A', { total_assets: '1000' }, { reportedAt: '2027-10-30' });
    await run();
    expect((await findings())).toHaveLength(1);
    expect((await findings())[0]!.detail.mismatches[0]).toMatchObject({ sec: '900', sec_accn: 'reexpresada' });
    expect((await row(b)).src).toBe('provider');
  });

  test('una cifra fuera de tolerancia basta para no marcar la fila, aunque las demás cuadren; una magnitud sin dato en la SEC se ignora', async () => {
    const co = await makeCompany('0000000103');
    const a = await fund(co, '2025-09-27', 'A', { revenue: '400', net_income: '100', total_assets: '1200' });
    const b = await fund(co, '2024-09-28', 'A', { revenue: '300', net_income: '90', total_assets: '900' });
    await storeFacts('0000000103', body({
      Revenues: [annual('2025-09-27', 400), annual('2024-09-28', 300, { start: '2023-10-01' })], NetIncomeLoss: [annual('2025-09-27', 100)], Assets: [instant('2025-09-27', 1000)],
    }));
    await run();
    expect((await row(a)).src).toBe('provider'); // activo 1200 frente a 1000
    expect((await findings())[0]!.detail.mismatches.map((m: { metric: string }) => m.metric)).toEqual(['total_assets']);
    expect((await row(b)).src).toBe('cross_checked'); // solo ingresos comparables y cuadran
  });

  test('sin payload de la SEC, sin cifras comparables, en otra divisa, sin CIK o con fuente estimada: la fila no cambia', async () => {
    const co = await makeCompany('0000000104');
    const noPayload = await fund(co, '2025-09-27', 'A', { revenue: '400' });
    const co2 = await makeCompany('0000000105');
    const other = await fund(co2, '2025-09-27', 'A', { revenue: '400' }); // el payload no tiene ese cierre
    const eur = await fund(co2, '2024-09-28', 'A', { revenue: '300' }, { currency: 'EUR' });
    const est = await fund(co2, '2023-09-30', 'A', { revenue: '200' }, { source: 'estimated' });
    await storeFacts('0000000105', body({ Revenues: [annual('2025-09-27', 400), annual('2024-09-28', 1, { start: '2023-10-01' }), annual('2023-09-30', 1, { start: '2022-10-01' })] }));
    await storeFacts('0000000105', body({ Revenues: [annual('2025-09-27', 400), annual('2024-09-28', 300, { start: '2023-10-01' }), annual('2023-09-30', 200, { start: '2022-10-01' })] }), { fetchedAt: '2026-10-14T10:00:00Z' }); // el último payload manda
    const s = await run();
    expect(s.ran.SECOND_SOURCE_MISMATCH).toMatchObject({ noPayload: 1, crossChecked: 1, mismatched: 0 });
    expect((await row(noPayload)).src).toBe('provider');
    expect((await row(other)).src).toBe('cross_checked');
    expect((await row(eur)).src).toBe('provider'); // otra divisa: ni se compara
    expect((await row(est)).src).toBe('estimated'); // fuente estimada: no se promociona
    // una respuesta 404 de la SEC no es un payload utilizable
    await storeFacts('0000000104', { error: 'no' }, { status: 404 });
    expect((await run()).ran.SECOND_SOURCE_MISMATCH).toMatchObject({ noPayload: 1 });
  });

  test('versión más reciente de cada periodo: se cruza la reexpresada, no la anterior', async () => {
    const co = await makeCompany('0000000106');
    await fund(co, '2025-09-27', 'A', { revenue: '999' }, { reportedAt: '2025-10-31' });
    const restated = await fund(co, '2025-09-27', 'A', { revenue: '400' }, { reportedAt: '2026-02-01' });
    await storeFacts('0000000106', body({ Revenues: [annual('2025-09-27', 400)] }));
    await run();
    expect((await row(restated)).src).toBe('cross_checked');
    expect(await findings()).toHaveLength(0);
  });
});
