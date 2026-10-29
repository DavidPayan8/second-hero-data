import type pg from 'pg';
import { avisoDe, type Aviso } from './avisos.js';

export type Queryable = pg.Pool | pg.PoolClient;
export type Decision = 'accepted' | 'rejected' | 'proposed';
const DECISIONES: readonly string[] = ['accepted', 'rejected', 'proposed'];
const AUTO = 'auto';

export interface FilaRevision {
  isin: string;
  symbol: string | null;
  type: string | null;
  name: string | null;
  status: Decision;
  reviewedBy: string | null;
  reviewedAt: string | null;
  aviso: Aviso;
  motivo: string;
}
export interface EmpresaRevision { lei: string; country: string | null; filas: FilaRevision[] }

export class RevisionError extends Error {
  constructor(public status: 400 | 404 | 409, msg: string) { super(msg); }
}

interface Fila {
  lei: string; isin: string; matched_symbol: string | null; matched_type: string | null; matched_name: string | null;
  status: Decision; reviewed_by: string | null; reviewed_at: Date | null; country: string | null;
}

// País del informe más reciente de cada LEI.
const SELECT_FILAS = `
  SELECT e.lei, e.isin, e.matched_symbol, e.matched_type, e.matched_name, e.status, e.reviewed_by, e.reviewed_at, f.country
  FROM esef_lei_isin e
  LEFT JOIN LATERAL (SELECT country FROM esef_filing WHERE lei = e.lei ORDER BY period_end DESC, esef_filing_id DESC LIMIT 1) f ON true`;

const aFila = (r: Fila, hermanas: Fila[]): FilaRevision => {
  const mapa = (x: Fila) => ({ lei: x.lei, isin: x.isin, matchedType: x.matched_type, country: x.country });
  const { aviso, motivo } = avisoDe(mapa(r), hermanas.filter((h) => h.isin !== r.isin).map(mapa));
  return {
    isin: r.isin, symbol: r.matched_symbol, type: r.matched_type, name: r.matched_name, status: r.status,
    reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null, aviso, motivo,
  };
};

export async function listar(c: Queryable, opts: { soloPendientes?: boolean } = {}): Promise<{
  empresas: EmpresaRevision[];
  resumen: { pendientes: number; aceptadas: number; rechazadas: number; auto: number };
}> {
  const rows = (await c.query<Fila>(`${SELECT_FILAS} ORDER BY e.lei, e.isin`)).rows;
  const porLei = new Map<string, Fila[]>();
  for (const r of rows) porLei.set(r.lei, [...(porLei.get(r.lei) ?? []), r]);
  const resumen = { pendientes: 0, aceptadas: 0, rechazadas: 0, auto: 0 };
  for (const r of rows) {
    if (r.reviewed_by === AUTO) resumen.auto++;
    else if (r.status === 'proposed') resumen.pendientes++;
    else if (r.status === 'accepted') resumen.aceptadas++;
    else resumen.rechazadas++;
  }
  const empresas: EmpresaRevision[] = [];
  for (const [lei, grupo] of porLei) {
    const humanas = grupo.filter((r) => r.reviewed_by !== AUTO);
    if (humanas.length === 0) continue;
    if (opts.soloPendientes && !humanas.some((r) => r.status === 'proposed')) continue;
    empresas.push({ lei, country: grupo[0]!.country, filas: humanas.map((r) => aFila(r, grupo)) });
  }
  return { empresas, resumen };
}

export async function decidir(c: Queryable, lei: string, isin: string, decision: Decision, usuario: string): Promise<FilaRevision> {
  if (!DECISIONES.includes(decision)) throw new RevisionError(400, 'decisión no válida');
  if (!usuario) throw new RevisionError(400, 'falta el usuario');
  const proposed = decision === 'proposed';
  const upd = await c.query(
    `UPDATE esef_lei_isin SET status = $3,
            reviewed_by = CASE WHEN $4 THEN NULL ELSE $5 END,
            reviewed_at = CASE WHEN $4 THEN NULL ELSE now() END
      WHERE lei = $1 AND isin = $2 AND reviewed_by IS DISTINCT FROM $6`,
    [lei, isin, decision, proposed, usuario, AUTO]);
  if (upd.rowCount === 0) {
    const existe = await c.query('SELECT 1 FROM esef_lei_isin WHERE lei = $1 AND isin = $2', [lei, isin]);
    if (existe.rowCount === 0) throw new RevisionError(404, 'no existe ese vínculo');
    throw new RevisionError(409, 'vínculo automático: no se edita desde el panel');
  }
  const grupo = (await c.query<Fila>(`${SELECT_FILAS} WHERE e.lei = $1`, [lei])).rows;
  return aFila(grupo.find((r) => r.isin === isin)!, grupo);
}

// Pasa a accepted las filas pendientes con aviso "sugerido". No rechaza nada ni toca "revisar", rejected ni auto.
export async function aplicarSugerencias(c: Queryable, usuario: string): Promise<{ cambiadas: number }> {
  if (!usuario) throw new RevisionError(400, 'falta el usuario');
  const { empresas } = await listar(c);
  const leis: string[] = [];
  const isins: string[] = [];
  for (const e of empresas) for (const f of e.filas) if (f.status === 'proposed' && f.aviso === 'sugerido') { leis.push(e.lei); isins.push(f.isin); }
  if (leis.length === 0) return { cambiadas: 0 };
  const r = await c.query(
    `UPDATE esef_lei_isin e SET status = 'accepted', reviewed_by = $3, reviewed_at = now()
       FROM unnest($1::text[], $2::text[]) AS t(lei, isin)
      WHERE e.lei = t.lei AND e.isin = t.isin AND e.status = 'proposed'`,
    [leis, isins, usuario]);
  return { cambiadas: r.rowCount ?? 0 };
}
