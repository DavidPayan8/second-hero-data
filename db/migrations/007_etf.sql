-- 007_etf: ETF_PROFILE, ETF_NAV_DAILY, ETF_HOLDING, ETF_ALLOCATION.
-- Spec: docs/modelo/modelo-entidades-etf.md, decisiones-modelo-etf.md.
-- Un ETF es una SECURITY con company_id NULL (el invariante contra ASSET_TYPE.requires_company lo hace el trigger T1
-- en 011_triggers). Las cuatro tablas cuelgan de SECURITY. Cantidades y porcentajes: numeric.
-- Criterio de NULL (decisiones-modelo-identidad.md §8): dato curado -> NOT NULL; dato del proveedor -> NULL si falta,
-- salvo que sin él la fila sea peligrosa o no signifique nada.
--
-- Esquema sin validar con datos reales: el plan Free de EODHD no incluye fundamentals, de donde sale todo el bloque
-- ETF_Data. Contrastado solo con la documentación del plugin eodhd-api; las discrepancias están en la propuesta
-- P7 (docs/propuestas-cambio-modelo.md).

-- Perfil del ETF: dimensión casi estática, 1:1 con SECURITY. Todo es dato del proveedor (nullable).
-- issuer es texto en v1 (gancho a una futura entidad ISSUER). expense_ratio: historial vía log de correcciones.
CREATE TABLE etf_profile (
  security_id    bigint  PRIMARY KEY REFERENCES security (security_id),
  issuer         text,
  inception_date date,
  index_tracked  text,
  category       text,
  domicile       text,
  expense_ratio  numeric
);

-- Serie diaria de NAV. El NAV no es el precio de mercado: se guarda aparte para poder derivar la prima/descuento.
-- Las acciones del ETF (creation/redemption) van aquí, no en SHARES_OUTSTANDING bitemporal.
-- nav y nav_currency obligatorios: un NAV sin divisa es peligroso (misma lección que FUNDAMENTALS.currency).
CREATE TABLE etf_nav_daily (
  security_id            bigint  NOT NULL REFERENCES security (security_id),
  date                   date    NOT NULL,
  nav                    numeric NOT NULL,
  nav_currency           text    NOT NULL,
  aum                    numeric,
  shares_outstanding_etf numeric,
  PRIMARY KEY (security_id, date)
);

-- Posiciones del ETF. Snapshot-temporal (la rotación de holdings es señal): as_of_date en la clave.
-- El constituyente se identifica por constituent_security_id (FK a SECURITY, cuando está en nuestro universo), con
-- constituent_isin y constituent_name como fallback. La resolución ISIN -> security_id es del normalizador.
-- weight_pct define el holding (NOT NULL); market_value y shares_held son datos adicionales del proveedor.
-- Clave: (security_id, constituent_key, as_of_date) con constituent_key = security_id resuelto, si no isin, si no nombre.
-- Los prefijos evitan que un nombre numérico choque con un id. Al menos un identificador: sin él la fila no
-- dice qué se posee y la clave sería NULL (UNIQUE no la protegería).
CREATE TABLE etf_holding (
  etf_holding_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id             bigint  NOT NULL REFERENCES security (security_id),
  as_of_date              date    NOT NULL,
  constituent_security_id bigint  REFERENCES security (security_id),
  constituent_isin        text,
  constituent_name        text,
  weight_pct              numeric NOT NULL,
  market_value            numeric,
  shares_held             numeric,
  CONSTRAINT etf_holding_has_constituent CHECK (
    constituent_security_id IS NOT NULL OR constituent_isin IS NOT NULL OR constituent_name IS NOT NULL
  )
);
CREATE UNIQUE INDEX etf_holding_key_idx ON etf_holding (
  security_id,
  (COALESCE('s:' || constituent_security_id::text, 'i:' || constituent_isin, 'n:' || constituent_name)),
  as_of_date
);
CREATE INDEX etf_holding_constituent_idx ON etf_holding (constituent_security_id) WHERE constituent_security_id IS NOT NULL;

-- Exposición del ETF por sector, país o tipo de activo. Snapshot-temporal.
-- Se guarda SIEMPRE la allocation del proveedor (source = 'provider'), que es la que se sirve. La derivada
-- (holdings x sector del constituyente) es validación y solo se guarda como source = 'derived' si el proveedor no la da.
-- bucket es el texto del proveedor (display/fallback). sector_id es el enlace canónico, solo con dimension = 'sector',
-- resuelto vía SOURCE_SECTOR_MAP (la misma tabla que clasifica las empresas); bucket sin mapeo -> sector_id NULL
-- y finding SECTOR_UNMAPPED. dimension y source son vocabularios del modelo, con CHECK.
CREATE TABLE etf_allocation (
  etf_allocation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id       bigint  NOT NULL REFERENCES security (security_id),
  as_of_date        date    NOT NULL,
  dimension         text    NOT NULL CHECK (dimension IN ('sector', 'country', 'asset_type')),
  bucket            text    NOT NULL,
  sector_id         bigint  REFERENCES sector (sector_id),
  weight_pct        numeric NOT NULL,
  source            text    NOT NULL CHECK (source IN ('provider', 'derived')),
  UNIQUE (security_id, as_of_date, dimension, bucket),
  CONSTRAINT etf_allocation_sector_only_for_sector CHECK (sector_id IS NULL OR dimension = 'sector')
);
CREATE INDEX etf_allocation_sector_id_idx ON etf_allocation (sector_id) WHERE sector_id IS NOT NULL;
