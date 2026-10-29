import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { insertarSiFalta, leerTodas, planPull, planPush, pullReviews, pushCandidates, upsertRevision, type FilaLeiIsin } from '../src/esef/sync.js';
import { inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const LEI = '5493006QMFDDMYWIAM13';
const T1 = '2026-10-28T10:00:00.000Z';
const T2 = '2026-10-29T10:00:00.000Z';
const fila = (isin: string, status: FilaLeiIsin['status'], reviewedBy: string | null, reviewedAt: string | null): FilaLeiIsin => ({
  lei: LEI, isin, source: 'gleif', matchedSymbol: 'X.LSE', matchedType: 'Common Stock', matchedName: 'X', status, reviewedBy, reviewedAt, generatedAt: T1,
});
const proposed = (isin: string) => fila(isin, 'proposed', null, null);
const humana = (isin: string, status: 'accepted' | 'rejected', by: string, at: string) => fila(isin, status, by, at);
const auto = (isin: string) => fila(isin, 'accepted', 'auto', T1);

describe('planPush', () => {
  test('solo las filas locales que faltan en remoto', () => {
    const local = [proposed('ES0113900J37'), proposed('US05964H1059'), auto('ES0178430E18')];
    const remoto = [humana('ES0113900J37', 'accepted', 'alberto', T2)];
    expect(planPush(local, remoto).map((f) => f.isin)).toEqual(['US05964H1059', 'ES0178430E18']);
  });
});

describe('planPull', () => {
  const I = 'ES0113900J37';
  test('fila ausente en local se inserta, también si es automática', () => {
    expect(planPull([humana(I, 'accepted', 'alberto', T2)], []).map((f) => f.isin)).toEqual([I]);
    expect(planPull([auto(I)], []).map((f) => f.isin)).toEqual([I]);
  });
  test('revisión humana remota pisa a local proposed o auto', () => {
    const r = humana(I, 'rejected', 'alberto', T2);
    expect(planPull([r], [proposed(I)])).toEqual([r]);
    expect(planPull([r], [auto(I)])).toEqual([r]);
  });
  test('si local es humana y más reciente no se pisa; si es más antigua o empata, sí', () => {
    const remota = humana(I, 'rejected', 'alberto', T1);
    expect(planPull([remota], [humana(I, 'accepted', 'david', T2)])).toEqual([]);
    expect(planPull([humana(I, 'rejected', 'alberto', T2)], [humana(I, 'accepted', 'david', T1)])).toHaveLength(1);
    expect(planPull([humana(I, 'rejected', 'alberto', T1)], [humana(I, 'accepted', 'david', T1)])).toHaveLength(1);
  });
  test('la vuelta a proposed en remoto se propaga solo si local está revisada por una persona', () => {
    expect(planPull([proposed(I)], [humana(I, 'accepted', 'david', T1)])).toEqual([proposed(I)]);
    expect(planPull([proposed(I)], [auto(I)])).toEqual([]);
    expect(planPull([proposed(I)], [proposed(I)])).toEqual([]);
  });
  test('una fila remota automática nunca pisa a la local', () => {
    expect(planPull([auto(I)], [humana(I, 'rejected', 'david', T1)])).toEqual([]);
    expect(planPull([auto(I)], [proposed(I)])).toEqual([]);
  });
  test('filas idénticas no generan cambio', () => {
    const r = humana(I, 'accepted', 'david', T1);
    expect(planPull([r], [{ ...r }])).toEqual([]);
  });
});

describe('escritura en la BD', () => {
  test('insertarSiFalta no pisa lo que existe; upsertRevision cambia solo la revisión, también a proposed', () => inRollback(async (c) => {
    await insertarSiFalta(c, [proposed('ES0113900J37'), proposed('US05964H1059')]);
    await insertarSiFalta(c, [humana('ES0113900J37', 'accepted', 'david', T1)]); // ya existía: no cambia
    let filas = await leerTodas(c);
    expect(filas.find((f) => f.isin === 'ES0113900J37')!.status).toBe('proposed');

    await upsertRevision(c, [humana('ES0113900J37', 'rejected', 'alberto', T2), { ...proposed('US05964H1059'), matchedName: 'otro nombre' }]);
    filas = await leerTodas(c);
    const a = filas.find((f) => f.isin === 'ES0113900J37')!;
    expect([a.status, a.reviewedBy, a.reviewedAt]).toEqual(['rejected', 'alberto', T2]);
    expect(filas.find((f) => f.isin === 'US05964H1059')!.matchedName).toBe('X'); // los datos de GLEIF no se tocan

    await upsertRevision(c, [proposed('ES0113900J37')]);
    const b = (await leerTodas(c)).find((f) => f.isin === 'ES0113900J37')!;
    expect([b.status, b.reviewedBy, b.reviewedAt]).toEqual(['proposed', null, null]);
  }));
  test('pushCandidates y pullReviews entre dos conexiones iguales no cambian nada y devuelven 0', () => inRollback(async (c) => {
    await insertarSiFalta(c, [proposed('ES0113900J37'), auto('ES0178430E18')]);
    expect(await pushCandidates(c, c)).toEqual({ insertadas: 0 });
    expect(await pullReviews(c, c)).toEqual({ actualizadas: 0 });
  }));
});
