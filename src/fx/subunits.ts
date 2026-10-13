// Divisa base de FX_RATES (decisiones-modelo.md 6.b): las filas guardan unidades de la divisa por 1 unidad de la base y la base no tiene filas.
export const BASE_CURRENCY = 'EUR';

// ÚNICO sitio con las divisas fraccionarias (subunidades): `GBX` es 1/100 de `GBP` (decisiones-modelo.md §6.a).
// PROVISIONAL: hoy solo hace falta GBX. Lo usan el escritor de FX (la fila `GBX` de FX_RATES se genera a partir de `GBP`)
// y la regla de listing primario (una cotización en GBX cuenta como la divisa de la bolsa si la bolsa usa GBP).
export const SUBUNITS: Record<string, { unit: string; factor: number }> = {
  GBX: { unit: 'GBP', factor: 100 },
};

// ¿La divisa de cotización es la de la bolsa o una subunidad de ella?
export function matchesCurrency(quoteCurrency: string, exchangeCurrency: string | null): boolean {
  if (!exchangeCurrency) return false;
  return quoteCurrency === exchangeCurrency || SUBUNITS[quoteCurrency]?.unit === exchangeCurrency;
}
