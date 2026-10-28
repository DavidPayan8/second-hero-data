-- 019_esef_lei_isin: candidatos LEI -> ISIN para enlazar los informes ESEF con los valores (P20, docs/propuestas-cambio-modelo.md).
-- El XBRL no trae ISIN ni ticker; el ISIN sale de GLEIF (/lei-records/{LEI}/isins) y solo se propone si el ISIN aparece en una lista
-- de bolsa capturada (exchange-symbol-list), lo que descarta la deuda del emisor. Comando: npm run esef-identify.
-- NO escribe en COMPANY ni SECURITY (docs/esef/propuesta.md, Identidad): sin FK a la fuente de verdad, el LEI y el ISIN son texto.
-- Regenerable salvo la revisión: el comando solo reescribe filas 'proposed' o aceptadas por la regla automática (reviewed_by = 'auto').
-- Una fila 'accepted' o 'rejected' por una persona no la toca nadie. Sin auditoría (dimension_audit): no es una dimensión del modelo.
CREATE TABLE esef_lei_isin (
  lei            text        NOT NULL CHECK (lei ~ '^[A-Z0-9]{20}$'),
  isin           text        NOT NULL CHECK (isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  source         text        NOT NULL CHECK (source IN ('gleif')),
  -- Cotización de la lista de bolsa que confirma el ISIN (la de menor símbolo si hay varias).
  matched_symbol text        NOT NULL,
  matched_type   text,
  matched_name   text,
  status         text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected')),
  reviewed_by    text,
  reviewed_at    timestamptz,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lei, isin),
  -- Revisado si y solo si ya no está propuesto.
  CONSTRAINT esef_lei_isin_review CHECK ((status = 'proposed') = (reviewed_at IS NULL) AND (status = 'proposed') = (reviewed_by IS NULL))
);
CREATE INDEX esef_lei_isin_isin_idx ON esef_lei_isin (isin);
