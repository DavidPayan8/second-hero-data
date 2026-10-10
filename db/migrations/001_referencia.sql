-- 001_referencia: datos de referencia del núcleo (ASSET_TYPE, EXCHANGE, SECTOR, INDUSTRY).
-- Spec: docs/modelo/modelo-entidades.md, modelo-entidades-taxonomia.md, decisiones-modelo-etf.md §1.

-- Catálogo de tipos de activo. El comportamiento va como dato:
--   in_screener_scope: filtra el screener.
--   requires_company: true = acción (SECURITY.company_id NOT NULL) / false = ETF (NULL).
-- El invariante con SECURITY y la inmutabilidad de requires_company los hacen triggers (009_triggers).
CREATE TABLE asset_type (
  asset_type_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             text    NOT NULL UNIQUE,
  in_screener_scope boolean NOT NULL,
  requires_company boolean NOT NULL
);

-- Bolsa real, clave = MIC (ISO 10383). No es el código del proveedor.
-- timezone (IANA) y close_time (hora local) sirven al disparo de materialización por cierre.
CREATE TABLE exchange (
  exchange_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mic              text NOT NULL UNIQUE,
  country_iso      text,
  default_currency text,
  timezone         text,
  close_time       time
);

-- Taxonomía canónica propia, dos niveles. Lo no clasificado es NULL en COMPANY, no una fila aquí.
CREATE TABLE sector (
  sector_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code      text NOT NULL UNIQUE,
  name      text NOT NULL
);

CREATE TABLE industry (
  industry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sector_id   bigint NOT NULL REFERENCES sector (sector_id),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL
);

CREATE INDEX industry_sector_id_idx ON industry (sector_id);
