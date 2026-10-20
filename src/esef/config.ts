// Segunda fuente europea: ESEF/UKSEF vía filings.xbrl.org (docs/esef/propuesta.md). ÚNICO sitio con los valores de captura y extracción.
export const ESEF_CONFIG = {
  provider: 'esef',
  base: 'https://filings.xbrl.org',
  // PROVISIONAL: pausa mínima entre el inicio de dos llamadas (cortesía: máximo 1 petición por segundo).
  minIntervalMs: 1100,
  // Informes por página del índice (el spike probó hasta 5000; con include=entity, 1000 son ~20 s y ~1,3 MB por página).
  indexPageSize: 1000,
  // FY2021 en adelante: cierres desde esta fecha (el period_end del índice se usa solo para este prefiltro; el cierre real sale de los hechos).
  firstClose: '2021-01-01',
  // El índice incluye Ucrania, que no es ESEF/UKSEF: queda fuera de cualquier lote.
  excludedCountries: ['UA'],
  // Informe anual: duración del periodo principal en días (de 340 a 380 cubre 52/53 semanas).
  annualMinDays: 340,
  annualMaxDays: 380,
  // Se sube cuando cambia cómo se extrae; el extractor regenera lo que tenga otra versión.
  extractorVersion: 'esef-extractor/1',
} as const;

export const ESEF_INDEX_ENDPOINT = 'filings-index';
export const ESEF_FILING_ENDPOINT = 'filing-json';
export const ESEF_INDEX_SCOPE = 'index';
