import type { Queryable } from '../admin/review.js';

// Sincronización de esef_lei_isin entre la BD local y Azure (docs/superpowers/specs/2026-10-28-panel-esef-design.md).
// Los candidatos nacen en local (esef-identify) y suben a Azure sin pisar nada; las revisiones se hacen en Azure
// (panel web) y bajan a local. La lógica de qué escribir está en planPush y planPull (puras); el resto es SQL.
export interface FilaLeiIsin {
  lei: string; isin: string; source: string;
  matchedSymbol: string | null; matchedType: string | null; matchedName: string | null;
  status: 'proposed' | 'accepted' | 'rejected';
  reviewedBy: string | null; reviewedAt: string | null; generatedAt: string;
}

const clave = (f: { lei: string; isin: string }): string => `${f.lei}/${f.isin}`;
const esHumana = (f: FilaLeiIsin): boolean => f.reviewedBy !== null && f.reviewedBy !== 'auto';
const ms = (f: FilaLeiIsin): number => (f.reviewedAt ? Date.parse(f.reviewedAt) : 0);

export function planPush(local: FilaLeiIsin[], remoto: FilaLeiIsin[]): FilaLeiIsin[] {
  const existentes = new Set(remoto.map(clave));
  return local.filter((f) => !existentes.has(clave(f)));
}

// Qué filas remotas hay que escribir en local. Azure manda para lo que una persona ha tocado:
//   - revisión humana remota: se escribe, salvo que la local sea humana y más reciente;
//   - vuelta a proposed remota: se escribe solo si la local está revisada por una persona;
//   - fila automática remota: solo se inserta si falta en local, nunca pisa.
export function planPull(remoto: FilaLeiIsin[], local: FilaLeiIsin[]): FilaLeiIsin[] {
  const porClave = new Map(local.map((f) => [clave(f), f]));
  const escribir: FilaLeiIsin[] = [];
  for (const r of remoto) {
    const l = porClave.get(clave(r));
    if (!l) escribir.push(r);
    else if (l.status === r.status && l.reviewedBy === r.reviewedBy && l.reviewedAt === r.reviewedAt) continue;
    else if (esHumana(r)) { if (!(esHumana(l) && ms(l) > ms(r))) escribir.push(r); }
    else if (r.reviewedBy === null) { if (esHumana(l)) escribir.push(r); }
  }
  return escribir;
}

interface Fila {
  lei: string; isin: string; source: string; matched_symbol: string | null; matched_type: string | null; matched_name: string | null;
  status: FilaLeiIsin['status']; reviewed_by: string | null; reviewed_at: Date | null; generated_at: Date;
}

export async function leerTodas(c: Queryable): Promise<FilaLeiIsin[]> {
  const rows = (await c.query<Fila>('SELECT * FROM esef_lei_isin ORDER BY lei, isin')).rows;
  return rows.map((r) => ({
    lei: r.lei, isin: r.isin, source: r.source, matchedSymbol: r.matched_symbol, matchedType: r.matched_type, matchedName: r.matched_name,
    status: r.status, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null, generatedAt: r.generated_at.toISOString(),
  }));
}

export async function insertarSiFalta(c: Queryable, filas: FilaLeiIsin[]): Promise<number> {
  let n = 0;
  for (const f of filas) {
    const r = await c.query(
      `INSERT INTO esef_lei_isin (lei, isin, source, matched_symbol, matched_type, matched_name, status, reviewed_by, reviewed_at, generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (lei, isin) DO NOTHING`,
      [f.lei, f.isin, f.source, f.matchedSymbol, f.matchedType, f.matchedName, f.status, f.reviewedBy, f.reviewedAt, f.generatedAt]);
    n += r.rowCount ?? 0;
  }
  return n;
}

// Inserta las que faltan y, en las que existen, cambia solo la revisión (los datos de GLEIF no se tocan).
export async function upsertRevision(c: Queryable, filas: FilaLeiIsin[]): Promise<number> {
  let n = 0;
  for (const f of filas) {
    const r = await c.query(
      `INSERT INTO esef_lei_isin (lei, isin, source, matched_symbol, matched_type, matched_name, status, reviewed_by, reviewed_at, generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (lei, isin) DO UPDATE SET status = EXCLUDED.status, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at`,
      [f.lei, f.isin, f.source, f.matchedSymbol, f.matchedType, f.matchedName, f.status, f.reviewedBy, f.reviewedAt, f.generatedAt]);
    n += r.rowCount ?? 0;
  }
  return n;
}

export async function pushCandidates(local: Queryable, remoto: Queryable): Promise<{ insertadas: number }> {
  const plan = planPush(await leerTodas(local), await leerTodas(remoto));
  return { insertadas: await insertarSiFalta(remoto, plan) };
}

export async function pullReviews(remoto: Queryable, local: Queryable): Promise<{ actualizadas: number }> {
  const plan = planPull(await leerTodas(remoto), await leerTodas(local));
  return { actualizadas: await upsertRevision(local, plan) };
}
