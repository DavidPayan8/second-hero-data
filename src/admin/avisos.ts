export type Aviso = 'sugerido' | 'revisar';

export interface FilaAviso {
  lei: string;
  isin: string;
  matchedType: string | null;
  country: string | null;
}

const prefijo = (isin: string): string => isin.slice(0, 2).toUpperCase();

// Reglas del spec (docs/superpowers/specs/2026-10-28-panel-esef-design.md): "revisar" si hay algo que una
// persona debería mirar; "sugerido" si es el candidato limpio. `hermanas` = las demás filas del mismo LEI.
export function avisoDe(fila: FilaAviso, hermanas: FilaAviso[]): { aviso: Aviso; motivo: string } {
  const p = prefijo(fila.isin);
  const pais = fila.country?.toUpperCase() ?? null;
  if (p === 'US' && pais !== 'US') return { aviso: 'revisar', motivo: 'ADR de EEUU: misma empresa, otro valor' };
  if (hermanas.some((h) => prefijo(h.isin) === p)) return { aviso: 'revisar', motivo: 'otra clase de acciones de la misma empresa' };
  if (pais === null || p !== pais) return { aviso: 'revisar', motivo: 'el prefijo del ISIN no coincide con el país del informe' };
  if (fila.matchedType !== 'Common Stock') return { aviso: 'revisar', motivo: `no es acción ordinaria (${fila.matchedType ?? 'sin tipo'})` };
  return { aviso: 'sugerido', motivo: 'único candidato con el prefijo del país del informe' };
}
