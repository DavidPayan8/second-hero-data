-- Seed: ASSET_TYPE. Idempotente. No se actualiza si ya existe: requires_company es
-- inmutable una vez el tipo tiene securities (trigger T2 en 010_triggers).
INSERT INTO asset_type (code, in_screener_scope, requires_company) VALUES
  ('common_stock', true, true),
  ('etf',          true, false)
ON CONFLICT (code) DO NOTHING;
