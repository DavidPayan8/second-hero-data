-- 009_noticias: NEWS, NEWS_SECURITY.
-- Spec: docs/modelo/modelo-noticias.md. Subsistema aparte: no es fuente de verdad financiera (no se valida, no se
-- deriva, no se reconcilia), pero vive en la misma base de datos, en tablas separadas (decisión de David, 2026-10-12).
-- Se sigue el modelo tal cual. Lo que no encaja con el fixture real news/AAPL.US.json está en la propuesta P8
-- (docs/propuestas-cambio-modelo.md), abierta: summary frente a content, publisher, tags y sentiment, clave natural y
-- símbolos fuera del universo. Hasta que se decida, estas columnas son provisionales y no se añade ninguna restricción
-- de unicidad ni ninguna columna nueva.

-- Una noticia. published_at y headline son los datos mínimos sin los cuales la fila no significa nada.
-- summary, url y publisher son datos del proveedor (nullable). Sin UNIQUE: la clave natural está pendiente (P8);
-- el índice no único por url es solo para localizar.
CREATE TABLE news (
  news_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  published_at timestamptz NOT NULL,
  headline     text        NOT NULL,
  summary      text,
  url          text,
  publisher    text
);
CREATE INDEX news_url_idx ON news (url) WHERE url IS NOT NULL;
CREATE INDEX news_published_at_idx ON news (published_at);

-- Etiquetado noticia -> security. Grano SECURITY (no LISTING ni COMPANY). Solo enlaza con securities que existen en
-- nuestro universo; qué se hace con los símbolos que no están es una pregunta abierta (P8).
CREATE TABLE news_security (
  news_id     bigint NOT NULL REFERENCES news (news_id),
  security_id bigint NOT NULL REFERENCES security (security_id),
  PRIMARY KEY (news_id, security_id)
);
CREATE INDEX news_security_security_id_idx ON news_security (security_id);
