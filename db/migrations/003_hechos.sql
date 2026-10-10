-- 003_hechos: FUNDAMENTALS, SHARES_OUTSTANDING, PRICES_DAILY, FX_RATES, STOCK_SPLIT, DIVIDEND, EARNINGS.
-- Spec: docs/modelo/modelo-entidades.md, decisiones-modelo.md §2, §5, §6, decisiones-modelo-earnings.md.
-- Todo se guarda en forma nativa e inmutable; lo derivable (EPS, P/E, precios ajustados...) NO se almacena.
-- Criterio de NULL (decisiones-modelo-identidad.md §8): dato curado -> NOT NULL; dato del proveedor -> NULL si falta,
-- salvo que sin él la fila sea peligrosa o no signifique nada.
--
-- Esquema sin validar con datos reales para FUNDAMENTALS, SHARES_OUTSTANDING y EARNINGS (el plan Free de EODHD no
-- incluye fundamentals ni earnings): se construyen según los docs del modelo. Ver docs/registro.md.

-- Estados financieros absolutos por empresa y periodo. Bitemporal: period_end = qué periodo cubre,
-- reported_at = cuándo se conoció. Un restatement es una fila nueva con reported_at posterior.
-- reported_at_source: de dónde salió la fecha; DEFAULT 'estimated' (el menos fiable es el default seguro).
-- cross_checked_at: lo rellena la validación al confirmar contra una 2ª fuente; NULL = aún no.
-- currency: divisa de REPORTE, independiente de LISTING.quote_currency.
-- Las líneas son dato del proveedor: NULL si faltan.
CREATE TABLE fundamentals (
  fundamentals_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         bigint      NOT NULL REFERENCES company (company_id),
  period_end         date        NOT NULL,
  period_type        char(1)     NOT NULL CHECK (period_type IN ('Q', 'A')),
  reported_at        date        NOT NULL,
  reported_at_source text        NOT NULL DEFAULT 'estimated'
                     CHECK (reported_at_source IN ('provider', 'provider_derived', 'estimated', 'manual', 'cross_checked')),
  cross_checked_at   timestamptz,
  currency           text        NOT NULL,
  revenue            numeric,
  gross_profit       numeric,
  ebitda             numeric,
  operating_income   numeric,
  net_income         numeric,
  operating_cf       numeric,
  capex              numeric,
  total_debt         numeric,
  cash               numeric,
  total_equity       numeric,
  total_assets       numeric,
  UNIQUE (company_id, period_end, period_type, reported_at)
);

-- Acciones en circulación por clase (security) y periodo. Mismo patrón bitemporal que FUNDAMENTALS.
CREATE TABLE shares_outstanding (
  shares_outstanding_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id           bigint  NOT NULL REFERENCES security (security_id),
  period_end            date    NOT NULL,
  reported_at           date    NOT NULL,
  reported_at_source    text    NOT NULL DEFAULT 'estimated'
                        CHECK (reported_at_source IN ('provider', 'provider_derived', 'estimated', 'manual', 'cross_checked')),
  shares                bigint  NOT NULL,
  UNIQUE (security_id, period_end, reported_at)
);

-- Precio BRUTO diario en divisa nativa del listing. Inmutable. Sin adjusted_close: el ajustado no es un dato,
-- se recalcula con cada split nuevo y se deriva en la capa de lectura (decisiones-modelo.md §5).
-- close es obligatorio (una fila sin cierre no significa nada); el resto es dato del proveedor.
CREATE TABLE prices_daily (
  listing_id bigint  NOT NULL REFERENCES listing (listing_id),
  date       date    NOT NULL,
  open       numeric,
  high       numeric,
  low        numeric,
  close      numeric NOT NULL,
  volume     bigint,
  PRIMARY KEY (listing_id, date)
);

-- Tipos de cambio a la base (EUR). Divisa fraccionaria (GBX) = fila propia con su tipo ya correcto.
-- rate_to_base > 0 porque el materializador divide y multiplica por él.
CREATE TABLE fx_rates (
  currency     text    NOT NULL,
  date         date    NOT NULL,
  rate_to_base numeric NOT NULL CHECK (rate_to_base > 0),
  PRIMARY KEY (currency, date)
);

-- Splits: numerador y denominador tal cual del proveedor (no siempre enteros limpios). 4:1 -> 4 y 1.
-- UNIQUE (security_id, ex_date): clave natural para que los escritores sean idempotentes.
-- Ambos > 0: el factor es numerator / denominator.
CREATE TABLE stock_split (
  stock_split_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id       bigint  NOT NULL REFERENCES security (security_id),
  ex_date           date    NOT NULL,
  split_numerator   numeric NOT NULL CHECK (split_numerator > 0),
  split_denominator numeric NOT NULL CHECK (split_denominator > 0),
  UNIQUE (security_id, ex_date)
);

-- Dividendos: amount_native = unadjustedValue del proveedor (NUNCA value, que se restata con cada split).
-- Solo ex_date entra en el ajuste; las otras fechas son metadata. currency NO es opcional.
-- period es vocabulario del proveedor (Quarterly, Annual, Interim, Final, Other...): texto sin CHECK.
-- Sin UNIQUE: la clave natural está pendiente de decidir (docs/propuestas-cambio-modelo.md P5).
CREATE TABLE dividend (
  dividend_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id      bigint  NOT NULL REFERENCES security (security_id),
  ex_date          date    NOT NULL,
  declaration_date date,
  record_date      date,
  payment_date     date,
  period           text,
  amount_native    numeric NOT NULL,
  currency         text    NOT NULL
);
CREATE INDEX dividend_security_ex_date_idx ON dividend (security_id, ex_date);

-- Calendario de resultados y estimaciones, una fila por (security, periodo fiscal). Hecho puntual mutable hasta
-- consolidar: solo el último estado (UPSERT por la PK). El EPS/revenue real NO se guarda (se deriva de FUNDAMENTALS).
-- report_time: vocabulario del modelo; 'unknown' es el valor honesto cuando el proveedor no lo da.
-- estimate_currency explícita: una estimación sin unidad es peligrosa, no se asume quote_currency.
CREATE TABLE earnings (
  security_id       bigint  NOT NULL REFERENCES security (security_id),
  fiscal_period_end date    NOT NULL,
  period_type       char(1) NOT NULL CHECK (period_type IN ('Q', 'A')),
  report_date       date,
  report_time       text    NOT NULL DEFAULT 'unknown' CHECK (report_time IN ('before_market', 'after_market', 'unknown')),
  eps_estimate      numeric,
  revenue_estimate  numeric,
  estimate_currency text,
  is_reported       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (security_id, fiscal_period_end, period_type),
  CONSTRAINT earnings_estimate_has_currency CHECK (
    estimate_currency IS NOT NULL OR (eps_estimate IS NULL AND revenue_estimate IS NULL)
  )
);
