-- 010_normalizador: INGESTION_RUN, PAYLOAD_BLOB, RAW_PAYLOAD, SOURCE_EXCHANGE, SOURCE_VENUE_MAP,
-- SOURCE_HOLDER_MAP, SOURCE_SECTOR_MAP.
-- Spec: docs/modelo/decisiones-modelo-ingesta.md, modelo-entidades-ingesta.md, decisiones-modelo-referencia.md,
-- decisiones-modelo-identidad.md §4 y decisiones-modelo-taxonomia.md §5.
-- Capa del normalizador: ninguna tabla de ingesta tiene FK a la fuente de verdad (el crudo no sabe que existe).
-- Las cuatro SOURCE_* entran en la auditoría T4 (012_triggers).

-- ---------------------------------------------------------------------------------------------------------------
-- Ingesta: payload crudo
-- ---------------------------------------------------------------------------------------------------------------

-- Corrida de ingesta: agrupa las llamadas de una jornada de un mercado. El materializador la consulta para saber que
-- un mercado está completo. scope identifica qué cubre (p. ej. eod:US, fundamentals:XETRA). partial = terminó pero con
-- errores en algunas llamadas (incluidos los fallos de transporte, que también dejan fila en raw_payload).
-- finished_at es NULL solo mientras corre. Una corrida cuyo proceso muere se queda en 'running': el orquestador
-- (Fase 3) la cierra como 'failed' al arrancar la siguiente del mismo scope.
CREATE TABLE ingestion_run (
  ingestion_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider         text        NOT NULL,
  scope            text        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  req_count        integer     NOT NULL DEFAULT 0,
  ok_count         integer     NOT NULL DEFAULT 0,
  error_count      integer     NOT NULL DEFAULT 0,
  CONSTRAINT ingestion_run_finished_iff_not_running CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX ingestion_run_scope_idx ON ingestion_run (provider, scope, started_at);

-- Cuerpo crudo direccionado por contenido: PK = sha256 en hexadecimal del cuerpo sin comprimir. Muchas filas de
-- RAW_PAYLOAD apuntan a un blob. Purgar = body NULL + purged_at: la fila (hash, tamaño) sobrevive para siempre.
CREATE TABLE payload_blob (
  content_hash  text        PRIMARY KEY CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  body          bytea,
  body_format   text        NOT NULL DEFAULT 'json',
  size_bytes    bigint      NOT NULL CHECK (size_bytes >= 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  purged_at     timestamptz,
  CONSTRAINT payload_blob_body_iff_not_purged CHECK ((body IS NULL) = (purged_at IS NOT NULL))
);

-- Una fila por llamada a la API. La metadata vive para siempre. provider_symbol es TEXTO, sin FK a LISTING: cuando
-- llega AAPL.US aún no se sabe qué security_id es (desacople deliberado). NULL en llamadas a nivel de bolsa.
-- Cada intento deja su fila aunque devuelva lo mismo (son eventos distintos); la idempotencia es la del blob.
-- Dos formas de fila, atadas por un único CHECK:
--   con respuesta   : http_status, content_hash y parse_status NOT NULL, transport_error NULL. Una respuesta HTTP de
--                     error (404, 429, 500) SÍ es respuesta: tiene cuerpo, está en payload_blob y lleva su http_status.
--   sin respuesta   : fallo de transporte (timeout, conexión cortada, DNS). http_status, content_hash y parse_status
--                     NULL (no hay cuerpo que guardar ni que parsear) y transport_error con el mensaje; el
--                     orquestador sabe así qué símbolos reintentar.
-- parse_error NOT NULL si y solo si parse_status = 'error'.
CREATE TABLE raw_payload (
  raw_payload_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingestion_run_id bigint      NOT NULL REFERENCES ingestion_run (ingestion_run_id),
  endpoint         text        NOT NULL,
  provider_symbol  text,
  params           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  http_status      integer,
  content_hash     text        REFERENCES payload_blob (content_hash),
  transport_error  text,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  parse_status     text        DEFAULT 'pending' CHECK (parse_status IN ('pending', 'ok', 'error')),
  parse_error      text,
  CONSTRAINT raw_payload_response_xor_transport_error CHECK (
    (transport_error IS NULL     AND http_status IS NOT NULL AND content_hash IS NOT NULL AND parse_status IS NOT NULL) OR
    (transport_error IS NOT NULL AND http_status IS NULL     AND content_hash IS NULL     AND parse_status IS NULL)
  ),
  CONSTRAINT raw_payload_parse_error_iff_error CHECK (COALESCE(parse_status = 'error', false) = (parse_error IS NOT NULL))
);
CREATE INDEX raw_payload_run_idx    ON raw_payload (ingestion_run_id);
CREATE INDEX raw_payload_hash_idx   ON raw_payload (content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX raw_payload_lookup_idx ON raw_payload (endpoint, provider_symbol, fetched_at);

-- ---------------------------------------------------------------------------------------------------------------
-- Referencia: código del proveedor <-> MIC
-- ---------------------------------------------------------------------------------------------------------------

-- Catálogo de códigos de bolsa del proveedor. kind decide cómo se resuelve:
--   single    -> una bolsa; default_mic obligatorio.
--   aggregate -> agrega varias (US = NYSE + NASDAQ + OTC...); el MIC se resuelve por símbolo con SOURCE_VENUE_MAP.
--   virtual   -> FOREX, CC...: fuera de alcance, el normalizador lo salta.
-- default_mic es NULL salvo en single. El normalizador nunca crea filas de EXCHANGE: un código cuyo MIC no está curado
-- no tiene fila aquí y produce VENUE_UNMAPPED.
CREATE TABLE source_exchange (
  provider      text NOT NULL,
  provider_code text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('single', 'aggregate', 'virtual')),
  default_mic   text REFERENCES exchange (mic),
  PRIMARY KEY (provider, provider_code),
  CONSTRAINT source_exchange_default_mic_iff_single CHECK ((kind = 'single') = (default_mic IS NOT NULL))
);

-- Sub-bolsa dentro de un agregado: (provider, provider_code, etiqueta de venue) -> MIC. La etiqueta genérica 'US'
-- NO lleva fila: el listing queda con exchange_id NULL y se emite VENUE_UNMAPPED. Solo debe haber filas para códigos
-- aggregate (regla del escritor).
CREATE TABLE source_venue_map (
  provider             text NOT NULL,
  provider_code        text NOT NULL,
  provider_venue_label text NOT NULL,
  mic                  text NOT NULL REFERENCES exchange (mic),
  PRIMARY KEY (provider, provider_code, provider_venue_label),
  FOREIGN KEY (provider, provider_code) REFERENCES source_exchange (provider, provider_code)
);
CREATE INDEX source_venue_map_mic_idx ON source_venue_map (mic);

-- ---------------------------------------------------------------------------------------------------------------
-- Identidad: memoria nombre -> holder_ref
-- ---------------------------------------------------------------------------------------------------------------

-- holder_name_norm es el nombre normalizado con la función de la 006 (una sola definición de normalización en la base
-- de datos). El CHECK exige que lo guardado ya esté normalizado. Una vez hay holder_ref para un nombre, la ingesta
-- no vuelve al nombre aunque el proveedor lo omita. Hoy EODHD no da ids de holder: la tabla es el gancho para un
-- proveedor futuro (p. ej. el CIK del filer en los 13F de la SEC).
CREATE TABLE source_holder_map (
  provider         text NOT NULL,
  holder_name_norm text NOT NULL,
  holder_ref       text NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, holder_name_norm),
  CONSTRAINT source_holder_map_name_is_normalized CHECK (holder_name_norm = holder_name_norm(holder_name_norm))
);

-- ---------------------------------------------------------------------------------------------------------------
-- Taxonomía: etiquetas del proveedor -> sector / industria canónicos
-- ---------------------------------------------------------------------------------------------------------------

-- Para que la industria destino pertenezca al sector destino de forma declarativa (un CHECK no ve otra tabla), se
-- añade a INDUSTRY una clave única (industry_id, sector_id) y SOURCE_SECTOR_MAP y COMPANY la referencian con una FK
-- compuesta.
-- Con industry_id NULL la FK compuesta no se comprueba (MATCH SIMPLE): "solo sector" sigue siendo válido.
ALTER TABLE industry ADD CONSTRAINT industry_industry_id_sector_id_key UNIQUE (industry_id, sector_id);

-- La misma FK compuesta en COMPANY: si sector_id e industry_id están los dos, tienen que casar con INDUSTRY (sustituye
-- al trigger T3). MATCH SIMPLE: si falta alguno de los dos no se comprueba nada, así que "solo sector" y "solo
-- industria" siguen siendo válidos (conocimiento parcial permitido, deriva bloqueada). Se suma a las FK simples de 002.
ALTER TABLE company ADD CONSTRAINT company_industry_id_sector_id_fkey
  FOREIGN KEY (industry_id, sector_id) REFERENCES industry (industry_id, sector_id);

-- Memoria texto del proveedor -> ids canónicos. provider_industry_label = '' si el proveedor no da industria.
-- sector_id siempre; industry_id solo si la industria es mapeable. Sin mapeo no hay fila: la company queda con ambos
-- NULL y se emite SECTOR_UNMAPPED. Doble consumidor: COMPANY y ETF_ALLOCATION.bucket (dimension = 'sector').
CREATE TABLE source_sector_map (
  provider                text NOT NULL,
  provider_sector_label   text NOT NULL,
  provider_industry_label text NOT NULL DEFAULT '',
  sector_id               bigint NOT NULL REFERENCES sector (sector_id),
  industry_id             bigint,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_sector_label, provider_industry_label),
  FOREIGN KEY (industry_id, sector_id) REFERENCES industry (industry_id, sector_id)
);
CREATE INDEX source_sector_map_sector_idx ON source_sector_map (sector_id);
