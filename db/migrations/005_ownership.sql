-- 005_ownership: HOLDER_POSITION, INSIDER_TRANSACTION, OWNERSHIP_SNAPSHOT, ANALYST_CONSENSUS, SHORT_INTEREST.
-- Spec: docs/modelo/modelo-entidades-ownership.md, decisiones-modelo-ownership.md.
-- Todas cuelgan de SECURITY. Toda cantidad (acciones, nº de analistas) es numeric; bigint solo para identificadores.
-- Criterio de NULL (decisiones-modelo-identidad.md §8): dato curado -> NOT NULL; dato del proveedor -> NULL si falta,
-- salvo que sin él la fila sea peligrosa o no signifique nada.
--
-- Esquema sin validar con datos reales: el plan Free de EODHD no incluye estos endpoints. Se construye según los
-- docs del modelo y se contrastó con la documentación del plugin eodhd-api; las discrepancias están en la
-- propuesta P6 (docs/propuestas-cambio-modelo.md).

-- Posición de un holder institucional o fondo. Snapshot-temporal: histórico conservado, as_of_date en la clave.
-- Identidad del holder: holder_ref (id estable del proveedor) preferido; holder_name es display y fallback.
-- La clave usa COALESCE(holder_ref, holder_name); su riesgo (nombre que varía entre snapshots) está nombrado en
-- decisiones-modelo-ownership.md §2.b.
-- portfolio_weight_pct: dato del proveedor, no derivable por nosotros.
CREATE TABLE holder_position (
  holder_position_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id          bigint      NOT NULL REFERENCES security (security_id),
  holder_ref           text,
  holder_name          text        NOT NULL,
  holder_type          text        NOT NULL CHECK (holder_type IN ('institution', 'fund')),
  as_of_date           date        NOT NULL,
  shares_held          numeric     NOT NULL,
  portfolio_weight_pct numeric,
  ingested_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX holder_position_key_idx
  ON holder_position (security_id, COALESCE(holder_ref, holder_name), as_of_date);

-- Transacción de insider. Hecho puntual append-only sin clave natural fiable. Dedup:
--   con provider_txn_id: UNIQUE (security_id, provider_txn_id);
--   sin él (fallback tolerable): UNIQUE (security_id, insider_name, transaction_date, transaction_code, shares_transacted).
-- Dos operaciones idénticas el mismo día sin id se fusionan: mal menor frente a duplicar en cada re-ingesta.
-- transaction_code es el código nativo del filing (P, S, A...): vocabulario del proveedor, sin CHECK.
CREATE TABLE insider_transaction (
  insider_transaction_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id            bigint      NOT NULL REFERENCES security (security_id),
  provider_txn_id        text,
  insider_name           text        NOT NULL,
  relationship           text,
  transaction_date       date        NOT NULL,
  transaction_code       text        NOT NULL,
  shares_transacted      numeric     NOT NULL,
  price_per_share        numeric,
  shares_owned_after     numeric,
  ingested_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX insider_transaction_provider_id_idx
  ON insider_transaction (security_id, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
CREATE UNIQUE INDEX insider_transaction_fallback_key_idx
  ON insider_transaction (security_id, insider_name, transaction_date, transaction_code, shares_transacted)
  WHERE provider_txn_id IS NULL;

-- Ownership agregada. Snapshot-temporal, as_of_date = fecha de la ingesta (General.UpdatedAt).
CREATE TABLE ownership_snapshot (
  security_id          bigint  NOT NULL REFERENCES security (security_id),
  as_of_date           date    NOT NULL,
  shares_float         numeric,
  percent_insiders     numeric,
  percent_institutions numeric,
  PRIMARY KEY (security_id, as_of_date)
);

-- Consenso de analistas. Snapshot-temporal.
-- rating_mean: agregado no descomponible. DIRECCIÓN DE LA ESCALA SIN RESOLVER: el modelo asume 1 = Strong Buy ..
-- 5 = Strong Sell, pero la documentación del plugin eodhd-api dice 5 = Strong Buy (propuesta P6). Se guarda tal cual
-- llega del proveedor y NO se debe interpretar hasta verificarlo con un payload real.
-- target_currency explícita: un precio objetivo sin divisa es peligroso, no se asume quote_currency.
CREATE TABLE analyst_consensus (
  security_id     bigint  NOT NULL REFERENCES security (security_id),
  as_of_date      date    NOT NULL,
  rating_mean     numeric,
  num_analysts    numeric,
  target_mean     numeric,
  target_low      numeric,
  target_high     numeric,
  target_currency text,
  PRIMARY KEY (security_id, as_of_date),
  CONSTRAINT analyst_consensus_target_has_currency CHECK (
    target_currency IS NOT NULL OR (target_mean IS NULL AND target_low IS NULL AND target_high IS NULL)
  )
);

-- Short interest: solo el hecho, no los ratios (short_ratio y short_percent_float se derivan).
-- shares_short_prior_month es solo fallback de arranque (decisiones-modelo-ownership.md §5.b); la fuente del
-- mes anterior es la propia serie.
CREATE TABLE short_interest (
  security_id               bigint  NOT NULL REFERENCES security (security_id),
  settlement_date           date    NOT NULL,
  shares_short              numeric NOT NULL,
  shares_short_prior_month  numeric,
  PRIMARY KEY (security_id, settlement_date)
);
