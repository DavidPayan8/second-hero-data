-- 009_noticias: NEWS, NEWS_SECURITY.
-- Spec: docs/modelo/modelo-noticias.md (propuesta P8, resuelta). Subsistema aparte: no es fuente de verdad financiera
-- (no se valida, no se deriva, no se reconcilia), sin auditoría (DIMENSION_AUDIT) ni findings. Vive en la misma base
-- de datos, en tablas separadas.

-- Una noticia. url (el link del proveedor, tal cual, sin normalizar) es la clave natural: sin url la fila no se puede
-- deduplicar ni enlazar, así que no se crea. published_at y headline tampoco admiten NULL: una noticia sin fecha o sin
-- titular no es mostrable ni ordenable.
-- Un refetch es un upsert por url: se actualizan published_at, headline, symbols, tags y sentiment_* (el proveedor
-- puede recalcular el sentimiento o corregir un titular). No se almacena el texto del artículo (content): es contenido
-- de terceros con derechos ajenos; tampoco summary ni publisher, que el proveedor no da.
-- symbols: lista cruda de símbolos EODHD, tal cual; permite reenlazar más tarde sin depender de RAW_PAYLOAD.
-- tags: vocabulario del proveedor, sin CHECK. sentiment_*: valores crudos del proveedor, sin CHECK de rango.
CREATE TABLE news (
  news_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url                text        NOT NULL UNIQUE,
  published_at       timestamptz NOT NULL,
  headline           text        NOT NULL,
  symbols            text[],
  tags               text[],
  sentiment_polarity numeric,
  sentiment_neg      numeric,
  sentiment_neu      numeric,
  sentiment_pos      numeric
);
CREATE INDEX news_published_at_idx ON news (published_at);

-- Etiquetado noticia -> security. Grano SECURITY (no LISTING ni COMPANY). Solo crece: un refetch añade enlaces y
-- nunca borra. Se puebla (Fase 3) resolviendo símbolo EODHD -> LISTING -> SECURITY; los símbolos que no resuelven
-- (índices, materias primas, privadas, listings fuera de universo) se ignoran sin finding.
CREATE TABLE news_security (
  news_id     bigint NOT NULL REFERENCES news (news_id),
  security_id bigint NOT NULL REFERENCES security (security_id),
  PRIMARY KEY (news_id, security_id)
);
CREATE INDEX news_security_security_id_idx ON news_security (security_id);
