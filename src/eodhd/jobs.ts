// Trabajos de captura: qué llamada hacer y cuánto cuesta en cuota.
// PROVISIONAL: la tabla COST de abajo es el ÚNICO sitio con el coste en cuota de cada endpoint. Sale de
// references/general/rate-limits.md del plugin eodhd-api y de lo observado en el plan Free (news con un ticker = 5;
// fundamentals = 10). Cada intento gasta su coste aunque falle, que es lo conservador. Hay que contrastarla con el panel.
export interface Job {
  // Plantilla de ruta con marcadores {symbol} y {code}: es lo que se guarda en raw_payload.endpoint.
  endpoint: string;
  // Símbolo del proveedor (AAPL.US). NULL en las llamadas a nivel de bolsa. Es lo que se guarda en provider_symbol.
  symbol?: string;
  // Parámetros de la llamada, incluidos los que van en la ruta ({code}); se guardan en raw_payload.params.
  params: Record<string, string>;
  // Llamadas de cuota que gasta un intento.
  cost: number;
}

const COST: Record<string, number> = {
  'exchanges-list': 1,
  'exchange-symbol-list/{code}': 1,
  'eod/{symbol}': 1,
  'div/{symbol}': 1,
  'splits/{symbol}': 1,
  news: 5,
  'fundamentals/{symbol}': 10,
};

// Ruta real a partir de la plantilla y los datos del trabajo. El token no interviene aquí.
export function resolvePath(job: Job): { path: string; query: Record<string, string> } {
  const query = { ...job.params };
  let path = job.endpoint;
  if (path.includes('{symbol}')) {
    if (!job.symbol) throw new Error(`${job.endpoint} necesita un símbolo`);
    path = path.replace('{symbol}', job.symbol);
  }
  if (path.includes('{code}')) {
    const code = query.code;
    if (!code) throw new Error(`${job.endpoint} necesita el parámetro code`);
    path = path.replace('{code}', code);
    delete query.code; // va en la ruta, no en la query
  }
  return { path, query };
}

const SYMBOL_ENDPOINTS: Record<string, { endpoint: string; params: Record<string, string> }> = {
  eod: { endpoint: 'eod/{symbol}', params: { period: 'd', order: 'a' } },
  div: { endpoint: 'div/{symbol}', params: {} },
  splits: { endpoint: 'splits/{symbol}', params: {} },
  fundamentals: { endpoint: 'fundamentals/{symbol}', params: {} },
};

// scope -> trabajos. El scope es `<tipo>:<etiqueta>`, p. ej. `symbols:LSE`, `symbols:US:delisted`, `exchanges`, `eod:adhoc`
// (con símbolos explícitos, hasta que el universo salga de LISTING).
export function buildJobs(scope: string, symbols: string[] = []): Job[] {
  const [kind, label, flag] = scope.split(':');
  if (kind === 'exchanges') return [{ endpoint: 'exchanges-list', params: {}, cost: COST['exchanges-list']! }];
  if (kind === 'symbols') {
    if (!label) throw new Error('scope symbols:<CODE> necesita el código de bolsa');
    const params: Record<string, string> = { code: label };
    if (flag === 'delisted') params.delisted = '1';
    else if (flag) throw new Error(`scope ${scope}: bandera desconocida ${flag}`);
    return [{ endpoint: 'exchange-symbol-list/{code}', params, cost: COST['exchange-symbol-list/{code}']! }];
  }
  if (kind === 'news') {
    return symbols.map((s) => ({ endpoint: 'news', symbol: s, params: { s, limit: '10' }, cost: COST.news! }));
  }
  const def = kind ? SYMBOL_ENDPOINTS[kind] : undefined;
  if (def) {
    if (!symbols.length) throw new Error(`scope ${scope}: indica los símbolos con --symbols=AAPL.US,...`);
    return symbols.map((s) => ({ endpoint: def.endpoint, symbol: s, params: { ...def.params }, cost: COST[def.endpoint]! }));
  }
  throw new Error(`scope desconocido: ${scope}`);
}
