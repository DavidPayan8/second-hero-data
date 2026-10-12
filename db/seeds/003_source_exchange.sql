-- Seed: SOURCE_EXCHANGE (códigos de bolsa de EODHD -> MIC). Idempotente.
-- Fuente: fixtures/eodhd/exchanges-list/all.json (70 códigos, capturado el 2026-10-10). Solo se siembran los códigos
-- cuya bolsa real ya está curada en EXCHANGE (002_exchange.sql): el normalizador nunca crea filas de EXCHANGE, así
-- que el resto de códigos (p. ej. F/XFRA, STU, MU, PR, BUD, AT, LU...) NO llevan fila y producirán VENUE_UNMAPPED.
--   single    : el OperatingMIC del payload es un único MIC. Excepción: MC (Madrid) trae OperatingMIC BMEX (operador de
--               BME Group) y se mapea a XMAD, la bolsa real que tenemos en EXCHANGE (decisión de David, 2026-10-12).
--   aggregate : US (OperatingMIC del payload: XNAS, XNYS, OTCM, XCBO); se resuelve por símbolo con SOURCE_VENUE_MAP.
--   virtual   : MONEY, EUFUND, GBOND, CC, FOREX (nombres "Virtual Exchange", Government Bonds, Cryptocurrencies, FOREX
--               en el payload); fuera de alcance, el normalizador los salta.
INSERT INTO source_exchange (provider, provider_code, kind, default_mic) VALUES
  ('eodhd', 'US',     'aggregate', NULL),
  ('eodhd', 'LSE',    'single',    'XLON'),
  ('eodhd', 'NEO',    'single',    'NEOE'),
  ('eodhd', 'V',      'single',    'XTSX'),
  ('eodhd', 'TO',     'single',    'XTSE'),
  ('eodhd', 'XETRA',  'single',    'XETR'),
  ('eodhd', 'VI',     'single',    'XWBO'),
  ('eodhd', 'PA',     'single',    'XPAR'),
  ('eodhd', 'BR',     'single',    'XBRU'),
  ('eodhd', 'SW',     'single',    'XSWX'),
  ('eodhd', 'MC',     'single',    'XMAD'),
  ('eodhd', 'LS',     'single',    'XLIS'),
  ('eodhd', 'AS',     'single',    'XAMS'),
  ('eodhd', 'CO',     'single',    'XCSE'),
  ('eodhd', 'ST',     'single',    'XSTO'),
  ('eodhd', 'OL',     'single',    'XOSL'),
  ('eodhd', 'HE',     'single',    'XHEL'),
  ('eodhd', 'IR',     'single',    'XDUB'),
  ('eodhd', 'WAR',    'single',    'XWAR'),
  ('eodhd', 'MONEY',  'virtual',   NULL),
  ('eodhd', 'EUFUND', 'virtual',   NULL),
  ('eodhd', 'GBOND',  'virtual',   NULL),
  ('eodhd', 'CC',     'virtual',   NULL),
  ('eodhd', 'FOREX',  'virtual',   NULL)
ON CONFLICT (provider, provider_code) DO UPDATE SET
  kind = EXCLUDED.kind,
  default_mic = EXCLUDED.default_mic;
