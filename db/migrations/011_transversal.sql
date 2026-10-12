-- 011_transversal: DIMENSION_AUDIT, VALIDATION_RULE, DATA_QUALITY_FINDING.
-- Spec: docs/modelo/decisiones-modelo-auditoria.md, modelo-entidades-auditoria.md,
-- decisiones-modelo-validacion.md, modelo-entidades-validacion.md.
-- Infraestructura transversal. DIMENSION_AUDIT y DATA_QUALITY_FINDING son polimórficas a propósito (table_name +
-- row_id, target_table + target_row_id como texto y bigint sueltos, SIN FK entrantes ni salientes a las tablas de
-- dominio): excepciones conscientes al anti-patrón, no hay que "arreglarlas" con una FK. Con esta migración están las
-- 36 tablas del modelo. Los triggers que escriben en DIMENSION_AUDIT están en 012_triggers.

-- Log de correcciones de las dimensiones mutables (que no tienen historial propio). Una fila por columna que
-- realmente cambió; las columnas de un mismo cambio lógico comparten change_set_id (uuid generado por el trigger, uno
-- por transacción, o fijado por la aplicación con app.change_set_id). old_value y new_value son texto (heterogéneo por
-- diseño). changed_by y reason salen de app.actor y app.reason (SET LOCAL); NULL en correcciones directas en SQL.
-- op = 'merge' lo usarán las fusiones de companies isolated (el mecanismo está pendiente, propuesta P10).
CREATE TABLE dimension_audit (
  dimension_audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  change_set_id      uuid        NOT NULL,
  table_name         text        NOT NULL,
  row_id             bigint      NOT NULL,
  column_name        text        NOT NULL,
  old_value          text,
  new_value          text,
  op                 text        NOT NULL CHECK (op IN ('insert', 'update', 'delete', 'merge')),
  changed_at         timestamptz NOT NULL DEFAULT now(),
  changed_by         text,
  reason             text
);
CREATE INDEX dimension_audit_row_idx        ON dimension_audit (table_name, row_id, changed_at);
CREATE INDEX dimension_audit_change_set_idx ON dimension_audit (change_set_id);

-- Catálogo de reglas de validación: el comportamiento como dato (apagar una regla o cambiar su severidad en
-- producción sin desplegar). La lógica de ejecución vive en el código de la aplicación, indexada por rule_code.
-- Todo productor de "marcar para revisión" emite con un rule_code catalogado, estructurales incluidos.
CREATE TABLE validation_rule (
  rule_code        text    PRIMARY KEY,
  description      text    NOT NULL,
  category         text    NOT NULL CHECK (category IN ('structural', 'data_quality')),
  default_severity text    NOT NULL CHECK (default_severity IN ('error', 'warning', 'info')),
  enabled          boolean NOT NULL DEFAULT true
);

-- Sumidero único de todo lo que requiere revisión humana (calidad y estructural). No bloquea la ingesta ni borra
-- nada: VISTAS filtra (excluye severity = 'error' AND status = 'open'; marca los warning abiertos).
-- severity es la copia efectiva al emitir (puede diferir del default de la regla). detected_by_run es NULL en los
-- barridos que no cuelgan de una corrida. detail lleva el contexto (valores, tolerancia, diff de la 2ª fuente).
CREATE TABLE data_quality_finding (
  finding_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_code       text        NOT NULL REFERENCES validation_rule (rule_code),
  severity        text        NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  target_table    text        NOT NULL,
  target_row_id   bigint      NOT NULL,
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'accepted', 'dismissed')),
  detail          jsonb,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  detected_by_run bigint      REFERENCES ingestion_run (ingestion_run_id),
  resolved_at     timestamptz,
  resolved_by     text
);
CREATE INDEX data_quality_finding_open_idx   ON data_quality_finding (rule_code, status);
CREATE INDEX data_quality_finding_target_idx ON data_quality_finding (target_table, target_row_id);
CREATE INDEX data_quality_finding_run_idx    ON data_quality_finding (detected_by_run) WHERE detected_by_run IS NOT NULL;
