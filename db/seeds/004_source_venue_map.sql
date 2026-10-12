-- Seed: SOURCE_VENUE_MAP (etiqueta de sub-bolsa del agregado US de EODHD -> MIC). Idempotente.
-- Fuente: campo Exchange de fixtures/eodhd/exchange-symbol-list/US.json (17 etiquetas, capturado el 2026-10-10) y la
-- decisión de decisiones-modelo-referencia.md §2.c (propuesta P9).
--   Una bolsa por etiqueta: NASDAQ -> XNAS, NYSE -> XNYS, NYSE ARCA -> ARCX, NYSE MKT y AMEX -> XASE (NYSE American,
--   antes AMEX), BATS -> BATS (Cboe BZX).
--   Los niveles de OTC Markets no son bolsas: se mapean todos al operador OTCM, para que un cambio de nivel no sea un
--   falso cambio de bolsa del LISTING (OTC, PINK, OTCPK, OTCQB, OTCQX, OTCMKTS, OTCGREY, OTCCE).
-- Sin fila a propósito:
--   OTCBB : el OTC Bulletin Board de FINRA ya no opera; asignarle OTCM sería suponer (5 símbolos -> VENUE_UNMAPPED).
--   US    : sub-bolsa no resuelta (556 símbolos) -> exchange_id NULL + VENUE_UNMAPPED.
--   NMFQS : fondos de inversión; el filtro por tipo va antes de resolver el venue, así que no generan VENUE_UNMAPPED.
-- Solo debe haber filas para códigos de kind 'aggregate' (lo comprueba un test sobre este seed).
INSERT INTO source_venue_map (provider, provider_code, provider_venue_label, mic) VALUES
  ('eodhd', 'US', 'NASDAQ',    'XNAS'),
  ('eodhd', 'US', 'NYSE',      'XNYS'),
  ('eodhd', 'US', 'NYSE ARCA', 'ARCX'),
  ('eodhd', 'US', 'NYSE MKT',  'XASE'),
  ('eodhd', 'US', 'AMEX',      'XASE'),
  ('eodhd', 'US', 'BATS',      'BATS'),
  ('eodhd', 'US', 'OTC',       'OTCM'),
  ('eodhd', 'US', 'PINK',      'OTCM'),
  ('eodhd', 'US', 'OTCPK',     'OTCM'),
  ('eodhd', 'US', 'OTCQB',     'OTCM'),
  ('eodhd', 'US', 'OTCQX',     'OTCM'),
  ('eodhd', 'US', 'OTCMKTS',   'OTCM'),
  ('eodhd', 'US', 'OTCGREY',   'OTCM'),
  ('eodhd', 'US', 'OTCCE',     'OTCM')
ON CONFLICT (provider, provider_code, provider_venue_label) DO UPDATE SET mic = EXCLUDED.mic;
