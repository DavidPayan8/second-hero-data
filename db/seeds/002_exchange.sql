-- Seed: EXCHANGE (bolsas reales por MIC) del universo: EEUU, Canadá y Europa.
-- Dato de referencia curado por nosotros, no del proveedor. PROVISIONAL: country_iso, default_currency y
-- timezone son estándar (ISO/IANA); close_time es el cierre nominal de la sesión continua según los
-- horarios públicos, escrito de memoria y SIN verificar contra la fuente de cada bolsa (ver docs/registro.md).
-- default_currency es la divisa de la bolsa, no la de un símbolo: nunca rellena LISTING.quote_currency.
-- Bolsas fuera de esta lista (p. ej. Frankfurt XFRA, Atenas) se añaden aquí cuando se curen.
INSERT INTO exchange (mic, country_iso, default_currency, timezone, close_time) VALUES
  -- EEUU (sub-bolsas del agregado US de EODHD)
  ('XNAS', 'US', 'USD', 'America/New_York', '16:00'),
  ('XNYS', 'US', 'USD', 'America/New_York', '16:00'),
  ('ARCX', 'US', 'USD', 'America/New_York', '16:00'),
  ('XASE', 'US', 'USD', 'America/New_York', '16:00'),
  ('BATS', 'US', 'USD', 'America/New_York', '16:00'),
  ('OTCM', 'US', 'USD', 'America/New_York', '16:00'),
  -- Canadá
  ('XTSE', 'CA', 'CAD', 'America/Toronto', '16:00'),
  ('XTSX', 'CA', 'CAD', 'America/Toronto', '16:00'),
  ('NEOE', 'CA', 'CAD', 'America/Toronto', '16:00'),
  -- Reino Unido y Europa
  ('XLON', 'GB', 'GBP', 'Europe/London',     '16:30'),
  ('XETR', 'DE', 'EUR', 'Europe/Berlin',     '17:30'),
  ('XPAR', 'FR', 'EUR', 'Europe/Paris',      '17:30'),
  ('XBRU', 'BE', 'EUR', 'Europe/Brussels',   '17:30'),
  ('XAMS', 'NL', 'EUR', 'Europe/Amsterdam',  '17:30'),
  ('XLIS', 'PT', 'EUR', 'Europe/Lisbon',     '17:30'),
  ('XDUB', 'IE', 'EUR', 'Europe/Dublin',     '16:30'),
  ('XMAD', 'ES', 'EUR', 'Europe/Madrid',     '17:30'),
  ('XSWX', 'CH', 'CHF', 'Europe/Zurich',     '17:30'),
  ('XSTO', 'SE', 'SEK', 'Europe/Stockholm',  '17:30'),
  ('XCSE', 'DK', 'DKK', 'Europe/Copenhagen', '17:00'),
  ('XOSL', 'NO', 'NOK', 'Europe/Oslo',       '16:20'),
  ('XHEL', 'FI', 'EUR', 'Europe/Helsinki',   '18:30'),
  ('XWBO', 'AT', 'EUR', 'Europe/Vienna',     '17:30'),
  ('XWAR', 'PL', 'PLN', 'Europe/Warsaw',     '17:00')
ON CONFLICT (mic) DO UPDATE SET
  country_iso = EXCLUDED.country_iso,
  default_currency = EXCLUDED.default_currency,
  timezone = EXCLUDED.timezone,
  close_time = EXCLUDED.close_time;
