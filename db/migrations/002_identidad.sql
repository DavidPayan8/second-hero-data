-- 002_identidad: COMPANY, SECURITY, LISTING, LISTING_TICKER_CHANGE.
-- Spec: docs/modelo/modelo-entidades.md, decisiones-modelo-identidad.md, modelo-entidades-identidad.md.
-- Los triggers T1 (SECURITY vs ASSET_TYPE.requires_company), T3 (COMPANY sector/industria) y T4 (auditoría)
-- van en 009_triggers; aquí solo estructura y restricciones declarativas.

-- Negocio emisor. Se agrupa por identificador oficial de emisor (CIK/LEI); sin id fiable, una COMPANY aislada
-- por security. identity_source registra con qué evidencia se agrupó. sector_id/industry_id NULL = no clasificado.
CREATE TABLE company (
  company_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legal_name            text   NOT NULL,
  lei                   text   UNIQUE,
  cik                   text   UNIQUE,
  identity_source       text   NOT NULL CHECK (identity_source IN ('cik', 'lei', 'isolated')),
  country_iso           text   CHECK (country_iso ~ '^[A-Z]{2}$'),
  sector_id             bigint REFERENCES sector (sector_id),
  industry_id           bigint REFERENCES industry (industry_id),
  fiscal_year_end_month integer CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  -- La evidencia declarada tiene que existir: no se agrupa "por cik" sin cik.
  CONSTRAINT company_identity_source_has_id CHECK (
    (identity_source <> 'cik' OR cik IS NOT NULL) AND (identity_source <> 'lei' OR lei IS NOT NULL)
  )
);
CREATE INDEX company_sector_id_idx   ON company (sector_id);
CREATE INDEX company_industry_id_idx ON company (industry_id);

-- Instrumento emitido (una clase de acción). company_id NULL = ETF (lo gobierna el trigger T1).
-- isin es el ancla primaria pero puede ser NULL (EODHD lo deja nulo en algunos valores; fallback (MIC, ticker)).
-- UNIQUE admite varios NULL.
CREATE TABLE security (
  security_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint REFERENCES company (company_id),
  asset_type_id bigint NOT NULL REFERENCES asset_type (asset_type_id),
  isin          text   UNIQUE
);
CREATE INDEX security_company_id_idx    ON security (company_id);
CREATE INDEX security_asset_type_id_idx ON security (asset_type_id);

-- Cotización de una security en una bolsa. provider_symbol es el crosswalk del camino rápido (v1, un proveedor).
-- quote_currency es la divisa nativa del símbolo (p. ej. GBX) y viene del proveedor símbolo a símbolo:
-- nunca se rellena con EXCHANGE.default_currency.
-- exchange_id queda nullable de forma provisional (venue desconocido -> sin MIC, ver propuestas-cambio-modelo.md P4).
-- status/status_date: dominio sin definir en el modelo, sin CHECK de momento (P4).
CREATE TABLE listing (
  listing_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id        bigint  NOT NULL REFERENCES security (security_id),
  exchange_id        bigint  REFERENCES exchange (exchange_id),
  ticker             text    NOT NULL,
  provider_symbol    text    NOT NULL UNIQUE,
  quote_currency     text    NOT NULL,
  is_primary_listing boolean NOT NULL DEFAULT false,
  status             text,
  status_date        date
);
CREATE INDEX listing_security_id_idx ON listing (security_id);
CREATE INDEX listing_exchange_id_idx ON listing (exchange_id);
-- Como máximo un listing primario por security (cuál es lo decide la aplicación, ver D1 en PLAN.md).
CREATE UNIQUE INDEX listing_one_primary_per_security_idx ON listing (security_id) WHERE is_primary_listing;

-- Historial de tickers de un listing (mismo listing_id al cambiar de símbolo).
CREATE TABLE listing_ticker_change (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id     bigint NOT NULL REFERENCES listing (listing_id),
  old_ticker     text   NOT NULL,
  new_ticker     text   NOT NULL,
  effective_date date   NOT NULL
);
CREATE INDEX listing_ticker_change_listing_id_idx ON listing_ticker_change (listing_id);
