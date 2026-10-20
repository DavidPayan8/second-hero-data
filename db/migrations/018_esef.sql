-- 018_esef: ESEF_FILING y ESEF_FACT (P19, docs/esef/propuesta.md §8.2; segunda fuente europea).
-- Proyección REGENERABLE del crudo: el cuerpo exacto vive en payload_blob (provider 'esef', body_format 'json+zstd', content_hash =
-- sha256 del cuerpo sin comprimir) y el extractor (src/esef/extract.ts) vacía y rehace estas tablas sin pérdida. Nadie las edita a mano.
-- Excepción controlada a "no guardar lo derivable" (propuesta §8.1): el panel de admin trabaja sobre ESEF_FACT.
-- Sin FK a la fuente de verdad (COMPANY/FUNDAMENTALS): el LEI es texto, como provider_symbol en raw_payload.
-- Fuera de esta migración (fases siguientes): esef_concept_map, la resolución de findings y el comparador.

-- Un informe anual (una presentación concreta: fxo_id lleva país y versión). Se guardan TODAS las presentaciones capturadas; cuál
-- vale para un (LEI, cierre) se calcula siempre sobre todo lo capturado (src/esef/choose.ts), no se guarda.
-- period_start / period_end son el periodo principal REAL, sacado de los hechos (el period_end del índice no es fiable);
-- index_period_end es el del índice, solo informativo.
CREATE TABLE esef_filing (
  esef_filing_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fxo_id             text        NOT NULL UNIQUE,
  content_hash       text        NOT NULL REFERENCES payload_blob (content_hash),
  index_sha256       text,
  lei                text        NOT NULL CHECK (lei ~ '^[A-Z0-9]{20}$'),
  country            text,
  period_start       date        NOT NULL,
  period_end         date        NOT NULL,
  index_period_end   date,
  processed_at       timestamptz,
  date_added         timestamptz,
  report_url         text,
  viewer_url         text,
  json_url           text,
  error_count        integer,
  warning_count      integer,
  inconsistency_count integer,
  ifrs_taxonomy      text,
  extractor_version  text        NOT NULL,
  CONSTRAINT esef_filing_period_order CHECK (period_start <= period_end)
);
CREATE INDEX esef_filing_lei_period_idx ON esef_filing (lei, period_end);
CREATE INDEX esef_filing_hash_idx ON esef_filing (content_hash);

-- Hechos numéricos SIN dimensiones del informe, todos los periodos (también los comparativos). Un instante lleva period_start NULL.
-- period_end es el cierre real (el xBRL-JSON da las 00:00 del día siguiente; el extractor resta ese día).
-- value es el texto exacto del informe (numeric, sin pasar por float); decimals NULL si el hecho no lo trae (o es INF).
-- Sin clave natural: un mismo concepto y periodo puede repetirse en el informe, y se conserva tal cual.
CREATE TABLE esef_fact (
  esef_fact_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  esef_filing_id    bigint  NOT NULL REFERENCES esef_filing (esef_filing_id),
  concept           text    NOT NULL,
  is_extension      boolean NOT NULL,
  period_start      date,
  period_end        date    NOT NULL,
  value             numeric NOT NULL,
  decimals          integer,
  unit              text    NOT NULL,
  extractor_version text    NOT NULL,
  CONSTRAINT esef_fact_period_order CHECK (period_start IS NULL OR period_start <= period_end)
);
CREATE INDEX esef_fact_filing_idx ON esef_fact (esef_filing_id, concept);
