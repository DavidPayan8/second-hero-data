import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { aplicarSugerencias, decidir, listar, RevisionError } from '../src/admin/review.js';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const LEI_SAN = '5493006QMFDDMYWIAM13';
const LEI_VOL = '549300HGV012CNC8JD22';
const LEI_AUTO = '549300EEJH4FEPDBBR25';

async function filing(c: pg.PoolClient, lei: string, country: string): Promise<void> {
  const hash = createHash('sha256').update(`blob-${lei}`).digest('hex');
  await c.query("INSERT INTO payload_blob (content_hash, body, body_format, size_bytes) VALUES ($1,'\\x7b7d','json',2)", [hash]);
  await c.query(
    `INSERT INTO esef_filing (fxo_id, content_hash, lei, country, period_start, period_end, extractor_version)
     VALUES ($1,$2,$3,$4,'2023-01-01','2023-12-31','test')`, [`test-review-${lei}`, hash, lei, country]);
}
async function fila(c: pg.PoolClient, lei: string, isin: string, symbol: string, type: string, status = 'proposed', by: string | null = null): Promise<void> {
  await c.query(
    `INSERT INTO esef_lei_isin (lei, isin, source, matched_symbol, matched_type, matched_name, status, reviewed_by, reviewed_at)
     VALUES ($1,$2,'gleif',$3,$4,$5,$6,$7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)`, [lei, isin, symbol, type, `Nombre ${symbol}`, status, by]);
}
async function sembrar(c: pg.PoolClient): Promise<void> {
  await filing(c, LEI_SAN, 'ES');
  await filing(c, LEI_VOL, 'SE');
  await filing(c, LEI_AUTO, 'ES');
  await fila(c, LEI_SAN, 'ES0113900J37', 'BNC.LSE', 'Common Stock');
  await fila(c, LEI_SAN, 'US05964H1059', '0HLE.LSE', 'Common Stock');
  await fila(c, LEI_VOL, 'SE0000115420', 'VOLV-A.ST', 'Common Stock');
  await fila(c, LEI_VOL, 'SE0000115446', '0HTP.LSE', 'Common Stock');
  await fila(c, LEI_AUTO, 'ES0178430E18', 'TEF.MC', 'Common Stock', 'accepted', 'auto');
}
const estado = async (c: pg.PoolClient, lei: string, isin: string) =>
  (await c.query('SELECT status, reviewed_by, reviewed_at FROM esef_lei_isin WHERE lei=$1 AND isin=$2', [lei, isin])).rows[0];

describe('listar', () => {
  test('agrupa por empresa, rellena avisos, omite filas auto y cuenta el resumen', () => inRollback(async (c) => {
    await sembrar(c);
    const r = await listar(c);
    expect(r.empresas.map((e) => e.lei).sort()).toEqual([LEI_SAN, LEI_VOL].sort());
    const san = r.empresas.find((e) => e.lei === LEI_SAN)!;
    expect(san.country).toBe('ES');
    expect(san.filas.find((x) => x.isin === 'ES0113900J37')!.aviso).toBe('sugerido');
    expect(san.filas.find((x) => x.isin === 'US05964H1059')!.aviso).toBe('revisar');
    expect(r.resumen).toEqual({ pendientes: 4, aceptadas: 0, rechazadas: 0, auto: 1 });
  }));
});

describe('decidir', () => {
  test('accepted guarda quién y cuándo', () => inRollback(async (c) => {
    await sembrar(c);
    const f = await decidir(c, LEI_SAN, 'ES0113900J37', 'accepted', 'david');
    expect(f.status).toBe('accepted');
    expect(f.reviewedBy).toBe('david');
    const e = await estado(c, LEI_SAN, 'ES0113900J37');
    expect(e.status).toBe('accepted');
    expect(e.reviewed_by).toBe('david');
    expect(e.reviewed_at).not.toBeNull();
  }));
  test('volver a proposed deja reviewed_by y reviewed_at en NULL', () => inRollback(async (c) => {
    await sembrar(c);
    await decidir(c, LEI_SAN, 'ES0113900J37', 'rejected', 'david');
    await decidir(c, LEI_SAN, 'ES0113900J37', 'proposed', 'david');
    const e = await estado(c, LEI_SAN, 'ES0113900J37');
    expect(e).toEqual({ status: 'proposed', reviewed_by: null, reviewed_at: null });
  }));
  test('valor inválido -> 400, par inexistente -> 404, fila auto -> 409, sin escribir', () => inRollback(async (c) => {
    await sembrar(c);
    await expect(decidir(c, LEI_SAN, 'ES0113900J37', 'borrar' as never, 'david')).rejects.toMatchObject({ status: 400 });
    await expect(decidir(c, LEI_SAN, 'ES0000000000', 'accepted', 'david')).rejects.toMatchObject({ status: 404 });
    await expect(decidir(c, LEI_AUTO, 'ES0178430E18', 'rejected', 'david')).rejects.toBeInstanceOf(RevisionError);
    await expect(decidir(c, LEI_AUTO, 'ES0178430E18', 'rejected', 'david')).rejects.toMatchObject({ status: 409 });
    expect((await estado(c, LEI_SAN, 'ES0113900J37')).status).toBe('proposed');
    expect(await estado(c, LEI_AUTO, 'ES0178430E18')).toMatchObject({ status: 'accepted', reviewed_by: 'auto' });
  }));
  test('un ISIN con comillas o SQL se trata como dato: 404 y la tabla intacta', () => inRollback(async (c) => {
    await sembrar(c);
    await expect(decidir(c, LEI_SAN, "x'; DELETE FROM esef_lei_isin; --", 'accepted', 'david')).rejects.toMatchObject({ status: 404 });
    expect((await c.query('SELECT count(*)::int AS n FROM esef_lei_isin')).rows[0].n).toBe(5);
  }));
});

describe('aplicarSugerencias', () => {
  test('acepta solo las pendientes con aviso sugerido; respeta revisar, rejected y auto', () => inRollback(async (c) => {
    await sembrar(c);
    await decidir(c, LEI_SAN, 'US05964H1059', 'rejected', 'alberto');
    const r = await aplicarSugerencias(c, 'david');
    expect(r.cambiadas).toBe(1); // solo ES0113900J37; Volvo son 'revisar' (otra clase)
    expect((await estado(c, LEI_SAN, 'ES0113900J37')).status).toBe('accepted');
    expect(await estado(c, LEI_SAN, 'US05964H1059')).toMatchObject({ status: 'rejected', reviewed_by: 'alberto' });
    expect((await estado(c, LEI_VOL, 'SE0000115420')).status).toBe('proposed');
    expect((await estado(c, LEI_AUTO, 'ES0178430E18')).reviewed_by).toBe('auto');
  }));
});
