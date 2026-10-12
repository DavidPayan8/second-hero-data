-- 007_etf: ETF_PROFILE, ETF_SNAPSHOT, ETF_HOLDING, ETF_ALLOCATION.
-- Spec: docs/modelo/modelo-entidades-etf.md, decisiones-modelo-etf.md (incluye §5, propuesta P7).
-- Un ETF es una SECURITY con company_id NULL (el invariante contra ASSET_TYPE.requires_company lo hace el trigger T1
-- en 011_triggers). Las cuatro tablas cuelgan de SECURITY. Cantidades y porcentajes: numeric.
-- Criterio de NULL (decisiones-modelo-identidad.md §8): dato curado -> NOT NULL; dato del proveedor -> NULL si falta,
-- salvo que sin él la fila sea peligrosa o no signifique nada.
--
-- Esquema sin validar con datos reales: el plan Free de EODHD no incluye fundamentals, de donde sale todo el bloque
-- ETF_Data. Contrastado solo con la documentación del plugin eodhd-api (propuesta P7, resuelta).

-- Perfil del ETF: dimensión casi estática, 1:1 con SECURITY. Todo es dato del proveedor (nullable).
-- issuer es texto en v1 (gancho a una futura entidad ISSUER). El historial lo cubre DIMENSION_AUDIT (T4).
-- expense_ratio en FRACCIÓN (0.0003 = 0,03 %), como viene NetExpenseRatio. El CHECK es una guarda de unidades: un valor
-- en porcentaje (0.20 queriendo decir 0,20 %) cae fuera y falla en vez de entrar como un 20 %. El 0 se guarda tal cual
-- (existen ETF con comisión cero y no se distingue de "no informado" sin inventar).
-- category es texto del proveedor (vacío en la doc); domicile es el nombre del país, no un código ISO.
CREATE TABLE etf_profile (
  security_id    bigint  PRIMARY KEY REFERENCES security (security_id),
  issuer         text,
  inception_date date,
  index_tracked  text,
  category       text,
  domicile       text,
  expense_ratio  numeric CHECK (expense_ratio >= 0 AND expense_ratio < 0.1)
);

-- Cifras del fondo observadas, snapshot-temporal (antes ETF_NAV_DAILY: para ETF no hay NAV diario documentado, solo
-- TotalAssets sin fecha). as_of_date = día en que lo observamos. La deduplicación por valor (no insertar una fila
-- igual a la última de ese ETF) es del escritor, Fase 3. Las acciones del ETF (creation/redemption) van aquí, no en
-- SHARES_OUTSTANDING bitemporal. Todo nullable salvo la clave; la divisa es obligatoria si hay aum o nav (una cifra
-- sin unidad es peligrosa, misma lección que FUNDAMENTALS.currency).
CREATE TABLE etf_snapshot (
  security_id            bigint  NOT NULL REFERENCES security (security_id),
  as_of_date             date    NOT NULL,
  aum                    numeric,
  nav                    numeric,
  currency               text,
  shares_outstanding_etf numeric,
  PRIMARY KEY (security_id, as_of_date),
  CONSTRAINT etf_snapshot_amount_has_currency CHECK (
    currency IS NOT NULL OR (aum IS NULL AND nav IS NULL)
  )
);

-- Posiciones del ETF. Snapshot-temporal (la rotación de holdings es señal): as_of_date en la clave.
-- El proveedor identifica al constituyente por su símbolo (AAPL.US), sin ISIN, importe ni fecha. constituent_symbol se
-- resuelve a constituent_security_id por el crosswalk de LISTING.provider_symbol (resolución: normalizador).
-- La clave usa SOLO identificadores del proveedor, nunca nuestra resolución: si dependiera de constituent_security_id,
-- una resolución que cambiara entre ejecuciones duplicaría la fila. Al menos uno de los tres, o la clave sería NULL.
-- weight_pct define el holding (NOT NULL); market_value y shares_held son datos adicionales del proveedor.
CREATE TABLE etf_holding (
  etf_holding_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id             bigint  NOT NULL REFERENCES security (security_id),
  as_of_date              date    NOT NULL,
  constituent_security_id bigint  REFERENCES security (security_id),
  constituent_symbol      text,
  constituent_isin        text,
  constituent_name        text,
  weight_pct              numeric NOT NULL,
  market_value            numeric,
  shares_held             numeric,
  CONSTRAINT etf_holding_has_constituent CHECK (
    constituent_symbol IS NOT NULL OR constituent_isin IS NOT NULL OR constituent_name IS NOT NULL
  )
);
CREATE UNIQUE INDEX etf_holding_key_idx ON etf_holding (
  security_id, as_of_date, (COALESCE(constituent_symbol, constituent_isin, constituent_name))
);
CREATE INDEX etf_holding_constituent_idx ON etf_holding (constituent_security_id) WHERE constituent_security_id IS NOT NULL;

-- Exposición del ETF por sector, región, capitalización o clase de activo. Snapshot-temporal.
-- dimension es vocabulario nuestro (CHECK); los bucket son del proveedor (sin CHECK). country desaparece: el proveedor
-- mezcla países y regiones en el mismo bloque y se guarda tal cual como region. weight_pct es el peso NETO.
-- Se guarda SIEMPRE la allocation del proveedor (source = 'provider'), que es la que se sirve. La derivada (holdings x
-- sector del constituyente) es validación y solo se guarda como source = 'derived' si el proveedor no la da.
-- sector_id es el enlace canónico, solo con dimension = 'sector', resuelto vía SOURCE_SECTOR_MAP (la misma tabla que
-- clasifica las empresas); bucket sin mapeo -> sector_id NULL y finding SECTOR_UNMAPPED.
CREATE TABLE etf_allocation (
  etf_allocation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id       bigint  NOT NULL REFERENCES security (security_id),
  as_of_date        date    NOT NULL,
  dimension         text    NOT NULL CHECK (dimension IN ('sector', 'region', 'market_cap', 'asset_class')),
  bucket            text    NOT NULL,
  sector_id         bigint  REFERENCES sector (sector_id),
  weight_pct        numeric NOT NULL,
  source            text    NOT NULL CHECK (source IN ('provider', 'derived')),
  UNIQUE (security_id, as_of_date, dimension, bucket),
  CONSTRAINT etf_allocation_sector_only_for_sector CHECK (sector_id IS NULL OR dimension = 'sector')
);
CREATE INDEX etf_allocation_sector_id_idx ON etf_allocation (sector_id) WHERE sector_id IS NOT NULL;
