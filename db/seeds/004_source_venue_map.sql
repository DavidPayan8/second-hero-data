-- Seed: SOURCE_VENUE_MAP (etiqueta de sub-bolsa del agregado US de EODHD -> MIC). Idempotente.
-- Fuente: campo Exchange de fixtures/eodhd/exchange-symbol-list/US.json (17 etiquetas distintas, capturado el
-- 2026-10-10). Solo las etiquetas cuya correspondencia con una bolsa es inequívoca:
--   NASDAQ -> XNAS, NYSE -> XNYS, NYSE ARCA -> ARCX, NYSE MKT y AMEX -> XASE (NYSE American, antes AMEX), OTC -> OTCM.
-- NO llevan fila (símbolo con exchange_id NULL + finding VENUE_UNMAPPED):
--   US: etiqueta genérica sin sub-bolsa (decisión de David, 2026-10-12).
--   BATS, NMFQS, PINK, OTCQB, OTCQX, OTCMKTS, OTCGREY, OTCPK, OTCCE y OTCBB: dudosas, pendientes de decisión en la
--   propuesta P9 (docs/propuestas-cambio-modelo.md).
INSERT INTO source_venue_map (provider, provider_code, provider_venue_label, mic) VALUES
  ('eodhd', 'US', 'NASDAQ',   'XNAS'),
  ('eodhd', 'US', 'NYSE',     'XNYS'),
  ('eodhd', 'US', 'NYSE ARCA', 'ARCX'),
  ('eodhd', 'US', 'NYSE MKT', 'XASE'),
  ('eodhd', 'US', 'AMEX',     'XASE'),
  ('eodhd', 'US', 'OTC',      'OTCM')
ON CONFLICT (provider, provider_code, provider_venue_label) DO UPDATE SET mic = EXCLUDED.mic;
