import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { compressBody, ESEF_BODY_FORMAT } from '../src/esef/codec.js';
import { identifyAll, loadListIndex, proposeCandidates, saveCandidates, type ListIndex } from '../src/esef/identify.js';
import { dbError, inRollback } from './helpers.js';

// P20: candidatos LEI -> ISIN. GLEIF se simula con un fetch inyectado (estos tests NO llaman a api.gleif.org).
beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const LEI_TEF = '549300EEJH4FEPDBBR25';
const LEI_BP = '213800LH1BZH3DI6G760';
const LEI_NONE = '959800FXZQY7U3P1G969';
const listed: ListIndex = new Map([
  ['ES0178430E18', { symbol: 'TEF.MC', type: 'Common Stock', name: 'Telefonica' }],
  ['US8793822086', { symbol: '0A2Y.LSE', type: 'Common Stock', name: 'Telefonica ADR' }],
  ['GB0007980591', { symbol: 'BP.LSE', type: 'Common Stock', name: 'BP' }],
  ['GB0001385250', { symbol: 'BP-A.LSE', type: 'Common Stock', name: 'BP A' }],
  ['FR0000120578', { symbol: 'SAN.PA', type: 'ETF', name: 'Sanofi fondo' }],
]);

describe('proposeCandidates', () => {
  test('un solo valor, acción ordinaria y prefijo = país del informe -> aceptado automático', () => {
    const c = proposeCandidates(LEI_TEF, 'ES', ['ES0178430E18', 'ES0000012345', 'XS0000000001'], listed);
    expect(c).toEqual([{ lei: LEI_TEF, isin: 'ES0178430E18', symbol: 'TEF.MC', type: 'Common Stock', name: 'Telefonica', status: 'accepted' }]);
  });
  test('varios valores (ADR o doble clase) -> todos propuestos, ninguno automático', () => {
    expect(proposeCandidates(LEI_TEF, 'ES', ['ES0178430E18', 'US8793822086'], listed).map((c) => c.status)).toEqual(['proposed', 'proposed']);
    expect(proposeCandidates(LEI_BP, 'GB', ['GB0007980591', 'GB0001385250'], listed).map((c) => c.isin)).toEqual(['GB0001385250', 'GB0007980591']);
  });
  test('prefijo distinto del país del informe, o tipo no ordinario -> propuesto', () => {
    expect(proposeCandidates(LEI_TEF, 'FR', ['ES0178430E18'], listed)[0]!.status).toBe('proposed');
    expect(proposeCandidates(LEI_TEF, 'FR', ['FR0000120578'], listed)[0]!.status).toBe('proposed');
  });
  test('ISIN de GLEIF que no está en ninguna lista (deuda) no se propone; los repetidos no duplican', () => {
    expect(proposeCandidates(LEI_TEF, 'ES', ['US00000000A1', 'US00000000A2'], listed)).toEqual([]);
    expect(proposeCandidates(LEI_TEF, 'ES', ['ES0178430E18', 'ES0178430E18'], listed)).toHaveLength(1);
  });
});

describe('esef_lei_isin', () => {
  const ins = "INSERT INTO esef_lei_isin (lei, isin, source, matched_symbol, status, reviewed_by, reviewed_at) VALUES ($1,$2,'gleif','X.MC',$3,$4,$5)";

  test('restricciones: formato de LEI e ISIN, estado en dominio, revisión coherente, PK (lei, isin)', () => inRollback(async (c) => {
    expect((await dbError(c, ins, ['corto', 'ES0178430E18', 'proposed', null, null]))?.code).toBe('23514');
    expect((await dbError(c, ins, [LEI_TEF, 'es0178430e18', 'proposed', null, null]))?.code).toBe('23514');
    expect((await dbError(c, ins, [LEI_TEF, 'ES0178430E18', 'maybe', null, null]))?.code).toBe('23514');
    expect((await dbError(c, ins, [LEI_TEF, 'ES0178430E18', 'accepted', null, null]))?.code).toBe('23514'); // aceptado sin revisor
    expect((await dbError(c, ins, [LEI_TEF, 'ES0178430E18', 'proposed', 'ana', new Date()]))?.code).toBe('23514'); // propuesto con revisor
    expect(await dbError(c, ins, [LEI_TEF, 'ES0178430E18', 'accepted', 'ana', new Date()])).toBeNull();
    expect((await dbError(c, ins, [LEI_TEF, 'ES0178430E18', 'rejected', 'ana', new Date()]))?.code).toBe('23505');
  }));

  test('saveCandidates: idempotente, refresca lo propuesto y lo automático, no pisa lo revisado por una persona', () => inRollback(async (c) => {
    const row = async (isin: string) => (await c.query('SELECT status, reviewed_by, matched_symbol FROM esef_lei_isin WHERE isin = $1', [isin])).rows[0];
    const auto = proposeCandidates(LEI_TEF, 'ES', ['ES0178430E18'], listed);
    await saveCandidates(c, auto);
    await saveCandidates(c, auto);
    expect((await c.query('SELECT count(*)::int AS n FROM esef_lei_isin')).rows[0].n).toBe(1);
    expect(await row('ES0178430E18')).toEqual({ status: 'accepted', reviewed_by: 'auto', matched_symbol: 'TEF.MC' });

    // Una persona rechaza el automático: la siguiente pasada ya no lo toca.
    await c.query("UPDATE esef_lei_isin SET status = 'rejected', reviewed_by = 'ana', reviewed_at = now() WHERE isin = 'ES0178430E18'");
    await saveCandidates(c, [{ ...auto[0]!, symbol: 'OTRO.MC' }]);
    expect(await row('ES0178430E18')).toEqual({ status: 'rejected', reviewed_by: 'ana', matched_symbol: 'TEF.MC' });

    // Lo automático se refresca: con un segundo candidato deja de serlo.
    await saveCandidates(c, proposeCandidates(LEI_BP, 'GB', ['GB0007980591'], listed));
    expect((await row('GB0007980591')).status).toBe('accepted');
    await saveCandidates(c, proposeCandidates(LEI_BP, 'GB', ['GB0007980591', 'GB0001385250'], listed));
    expect(await row('GB0007980591')).toEqual({ status: 'proposed', reviewed_by: null, matched_symbol: 'BP.LSE' });
  }));
});

describe('identifyAll', () => {
  const gleif = new Map<string, string[] | number>([[LEI_TEF, ['ES0178430E18', 'US00000000A1']], [LEI_BP, ['GB0007980591', 'GB0001385250']], [LEI_NONE, 404]]);

  test('lee las listas de bolsa guardadas, pide a GLEIF cada LEI, filtra y guarda; sin EEUU; 404 cuenta aparte', () => inRollback(async (c) => {
    const run = (await c.query("INSERT INTO ingestion_run (provider, scope, status, finished_at) VALUES ('eodhd','symbols:test','ok', now()) RETURNING ingestion_run_id AS id")).rows[0].id;
    // Listas sintéticas guardadas como las guarda el normalizador (payload_blob + raw_payload).
    const lists: [string, object[]][] = [
      ['MC', [{ Code: 'TEF', Exchange: 'MC', Type: 'Common Stock', Name: 'Telefonica', Isin: 'ES0178430E18' }]],
      ['LSE', [{ Code: 'BP', Exchange: 'LSE', Type: 'Common Stock', Name: 'BP', Isin: 'GB0007980591' }, { Code: 'BP-A', Exchange: 'LSE', Type: 'Common Stock', Name: 'BP A', Isin: 'GB0001385250' }]],
      ['US', [{ Code: 'TEFAD', Exchange: 'NYSE', Type: 'Common Stock', Name: 'ADR', Isin: 'US8793822086' }]],
    ];
    let mcHash = '';
    for (const [code, body] of lists) {
      const raw = Buffer.from(JSON.stringify(body));
      const hash = createHash('sha256').update(raw).digest('hex');
      if (code === 'MC') mcHash = hash;
      await c.query('INSERT INTO payload_blob (content_hash, body, body_format, size_bytes) VALUES ($1,$2,$3,$4)', [hash, compressBody(raw), ESEF_BODY_FORMAT, raw.length]);
      await c.query("INSERT INTO raw_payload (ingestion_run_id, endpoint, params, http_status, content_hash) VALUES ($1,'exchange-symbol-list/{code}',$2,200,$3)", [run, JSON.stringify({ code }), hash]);
    }
    const index = await loadListIndex(c);
    expect(index.has('US8793822086')).toBe(false); // EEUU fuera
    expect([...index.keys()].sort()).toEqual(['ES0178430E18', 'GB0001385250', 'GB0007980591']);

    for (const [lei, country] of [[LEI_TEF, 'ES'], [LEI_BP, 'GB'], [LEI_NONE, 'ES']] as const) {
      await c.query(
        `INSERT INTO esef_filing (fxo_id, content_hash, lei, country, period_start, period_end, extractor_version)
         VALUES ($1,$2,$3,$4,'2023-01-01','2023-12-31','test')`, [`test-identify-${lei}`, mcHash, lei, country]);
    }
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      urls.push(String(url));
      const v = gleif.get(/lei-records\/([A-Z0-9]{20})\/isins/.exec(String(url))![1]!)!;
      if (typeof v === 'number') return new Response('{}', { status: v });
      return new Response(JSON.stringify({ data: v.map((isin) => ({ attributes: { isin } })), meta: { pagination: { lastPage: 1 } } }), { status: 200 });
    }) as typeof fetch;

    const stats = await identifyAll({ db: c, fetch: fakeFetch, sleep: async () => undefined, leis: [LEI_TEF, LEI_BP, LEI_NONE] });
    expect(stats).toMatchObject({ leis: 3, listIsins: 3, withCandidate: 2, accepted: 1, proposed: 2, noGleifIsin: 1, failed: 0 });
    expect(urls).toHaveLength(3);
    const { rows } = await c.query('SELECT lei, isin, status FROM esef_lei_isin ORDER BY lei, isin');
    expect(rows).toEqual([
      { lei: LEI_BP, isin: 'GB0001385250', status: 'proposed' },
      { lei: LEI_BP, isin: 'GB0007980591', status: 'proposed' },
      { lei: LEI_TEF, isin: 'ES0178430E18', status: 'accepted' },
    ]);
  }));
});
