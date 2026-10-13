// Países de bolsa (EXCHANGE.country_iso) del listing PRIMARIO donde General.CurrencyCode se da por buena como divisa de los datos
// del proveedor que no traen divisa propia: aum de ETF_SNAPSHOT (P15) y precio objetivo de ANALYST_CONSENSUS (P17). Fuera de estos
// países la divisa no se supone (una línea de Londres en GBX de un fondo en USD guardaría la unidad equivocada) y el dato queda NULL
// hasta verificarlo con un valor europeo. ÚNICO sitio (decisiones-modelo-etf.md 2.b y decisiones-modelo-ownership.md 4).
export const TRUSTED_QUOTE_CURRENCY_COUNTRIES: readonly string[] = ['US'];

export const isTrustedQuoteCurrencyCountry = (country: string | null): boolean => country !== null && TRUSTED_QUOTE_CURRENCY_COUNTRIES.includes(country);
