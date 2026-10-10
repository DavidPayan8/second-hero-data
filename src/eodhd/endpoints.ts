// Cola de captura de la Fase 1 para el PLAN GRATIS (20 llamadas/día, 1 año de histórico).
// Plan gratis incluye: EOD (1 año), dividendos/splits (1 año), live retrasado, news, sentiment, tesoro US.
// NO listado en el plan: fundamentals, earnings, insider, symbol-change-history, holders, ETF.
// `cost`: llamadas de cuota por petición, según references/general/rate-limits.md del plugin eodhd-api 0.8.0:
//   fundamentals = 10, news = 5 con un ticker (observado),
//   symbol-change-history = 5, resto = 1. Errores HTTP cuestan 0 según la doc, pero aquí se cuentan igual.
export interface Job {
  endpoint: string; // carpeta bajo fixtures/eodhd/
  key: string; // nombre del fichero (sin .json)
  path: string; // ruta bajo /api/
  params?: Record<string, string>;
  cost: number;
}

const eod = (s: string): Job => ({
  endpoint: 'eod', key: s, path: `eod/${s}`, params: { period: 'd', order: 'a' }, cost: 1,
});

export const QUEUE: Job[] = [
  // Referencia: ¿lista de bolsas y lista de símbolos entran en el plan? (C5 sub-bolsa, C6 deslistadas)
  { endpoint: 'exchanges-list', key: 'all', path: 'exchanges-list', cost: 1 },
  { endpoint: 'exchange-symbol-list', key: 'US', path: 'exchange-symbol-list/US', cost: 1 },
  { endpoint: 'exchange-symbol-list', key: 'US-delisted', path: 'exchange-symbol-list/US', params: { delisted: '1' }, cost: 1 },
  // Precios: SHEL.LSE primero (GBX, parte de C4)
  eod('SHEL.LSE'), eod('SAP.XETRA'), eod('ITX.MC'), eod('SHOP.TO'),
  eod('AAPL.US'), eod('GOOGL.US'), eod('GOOG.US'), eod('KO.US'), eod('META.US'),
  eod('JPM.US'), eod('O.US'), eod('VTI.US'),
  // FX
  eod('EURUSD.FOREX'), eod('EURGBP.FOREX'), eod('EURCAD.FOREX'),
  // C7: formato de dividendos y splits
  { endpoint: 'div', key: 'AAPL.US', path: 'div/AAPL.US', cost: 1 },
  { endpoint: 'splits', key: 'AAPL.US', path: 'splits/AAPL.US', cost: 1 },
  // Bono de 500 llamadas (extraLimit): C6 profundidad de deslistadas, divisas/dividendos fuera de EEUU
  eod('TWTR.US'), eod('BBBY_old.US'), eod('LEH.US'), eod('CS.US'),
  { endpoint: 'div', key: 'TWTR.US', path: 'div/TWTR.US', cost: 1 },
  { endpoint: 'div', key: 'CS.US', path: 'div/CS.US', cost: 1 },
  { endpoint: 'div', key: 'SHEL.LSE', path: 'div/SHEL.LSE', cost: 1 },
  { endpoint: 'div', key: 'ITX.MC', path: 'div/ITX.MC', cost: 1 },
  { endpoint: 'div', key: 'SHOP.TO', path: 'div/SHOP.TO', cost: 1 },
  // Día 2+
  { endpoint: 'news', key: 'AAPL.US', path: 'news', params: { s: 'AAPL.US', limit: '10' }, cost: 5 }, // C13
  { endpoint: 'div', key: 'SAP.XETRA', path: 'div/SAP.XETRA', cost: 1 },
  // Capturado el 2026-10-10 y descartado: fundamentals devuelve 403 en el plan Free. symbol-change-history exige
  // All World Extended o All-In-One: reañadir a la cola cuando haya plan de pago (C1, C14).
];
