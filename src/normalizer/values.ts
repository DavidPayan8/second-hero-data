// Lectores pequeños de valores de un payload del proveedor, compartidos por los escritores de fundamentals/{symbol}.
// Los números llegan como texto exacto (parseJsonExact): `text` los devuelve tal cual y Postgres los guarda como numeric.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const date = (v: unknown): string | null => (typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) ? v : null);
export const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Entradas de un bloque del proveedor que viene como objeto indexado ("0", "1"...) o como lista.
export const entries = (v: unknown): unknown[] => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : []);
// Entero escrito como texto ("19"), si lo es.
export const intText = (v: unknown): string | null => { const t = text(v); return t !== null && /^-?\d+$/.test(t) ? t : null; };

export type Discarded = { reason: string; detail: unknown };
