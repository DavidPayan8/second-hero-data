-- 013_clave_jsonb_findings: la clave de fila del log de auditoría y de los findings pasa a jsonb, T4 cubre las 13
-- dimensiones, op = 'merge' tiene mecanismo y los findings abiertos son únicos.
-- Decisiones: docs/modelo/decisiones-modelo-auditoria.md §3-§5, decisiones-modelo-validacion.md §6 y
-- modelo-entidades-validacion.md "Convenciones de target" (propuestas P10 y P11). La 011 y la 012 ya estaban
-- publicadas, por eso todo va en una migración nueva.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. DIMENSION_AUDIT: row_id bigint -> row_key jsonb (la PK de la fila como objeto: {"company_id": 42} o
--    {"provider": "eodhd", "provider_code": "US"}). Sirve para cualquier PK, simple o compuesta, de texto o numérica.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE dimension_audit ADD COLUMN row_key jsonb;

-- Relleno de las filas que ya hubiera (las de la 012 son de ocho tablas con PK bigint de una sola columna).
UPDATE dimension_audit d
SET row_key = jsonb_build_object(m.pk, d.row_id)
FROM (VALUES
  ('company', 'company_id'), ('security', 'security_id'), ('listing', 'listing_id'), ('exchange', 'exchange_id'),
  ('asset_type', 'asset_type_id'), ('etf_profile', 'security_id'), ('sector', 'sector_id'), ('industry', 'industry_id')
) AS m(tbl, pk)
WHERE d.table_name = m.tbl;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dimension_audit WHERE row_key IS NULL) THEN
    RAISE EXCEPTION '013: hay filas de dimension_audit de una tabla sin clave conocida; no se inventa su row_key';
  END IF;
END $$;

ALTER TABLE dimension_audit ALTER COLUMN row_key SET NOT NULL;
ALTER TABLE dimension_audit ADD CONSTRAINT dimension_audit_row_key_is_object CHECK (jsonb_typeof(row_key) = 'object');
ALTER TABLE dimension_audit DROP COLUMN row_id;  -- arrastra el índice dimension_audit_row_idx
CREATE INDEX dimension_audit_row_idx ON dimension_audit (table_name, row_key);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. T4 genérico: audit_dimension() lee la PK de la tabla de pg_index, sin configuración por tabla.
--    op = 'merge': la aplicación hace SET LOCAL app.op = 'merge' y el trigger lo aplica SOLO a las filas de UPDATE
--    (INSERT y DELETE conservan su op). Con app.op = 'merge', app.reason es obligatorio: una fusión sin motivo no se
--    puede revisar. Cualquier otro valor de app.op es un error.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_dimension() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_old    jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  v_new    jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  v_row    jsonb := CASE WHEN TG_OP = 'DELETE' THEN v_old ELSE v_new END;
  v_cs     uuid  := nullif(current_setting('app.change_set_id', true), '')::uuid;
  v_actor  text  := nullif(current_setting('app.actor', true), '');
  v_reason text  := nullif(current_setting('app.reason', true), '');
  v_appop  text  := nullif(current_setting('app.op', true), '');
  v_op     text  := lower(TG_OP);
  v_key    jsonb;
  v_col    text;
BEGIN
  IF v_appop IS NOT NULL AND v_appop <> 'merge' THEN
    RAISE EXCEPTION 'app.op = % no es válido: el único valor admitido es merge', v_appop
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_appop = 'merge' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'app.op = merge exige app.reason: una fusión sin motivo no se puede revisar'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_appop = 'merge' AND TG_OP = 'UPDATE' THEN
    v_op := 'merge';
  END IF;

  -- La PK de la tabla como objeto JSON, con los valores de la propia fila.
  SELECT jsonb_object_agg(a.attname, v_row -> a.attname) INTO v_key
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
  WHERE i.indrelid = TG_RELID AND i.indisprimary;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'audit_dimension: la tabla % no tiene clave primaria', TG_TABLE_NAME;
  END IF;

  IF v_cs IS NULL THEN
    v_cs := gen_random_uuid();
    PERFORM set_config('app.change_set_id', v_cs::text, true);
  END IF;

  FOR v_col IN SELECT jsonb_object_keys(v_old || v_new) LOOP
    IF (v_old ->> v_col) IS DISTINCT FROM (v_new ->> v_col) THEN
      INSERT INTO dimension_audit (change_set_id, table_name, row_key, column_name, old_value, new_value, op, changed_by, reason)
      VALUES (v_cs, TG_TABLE_NAME, v_key, v_col, v_old ->> v_col, v_new ->> v_col, v_op, v_actor, v_reason);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Los triggers existentes pasaban el nombre de la PK como argumento, que ya no hace falta: se recrean sin él.
DROP TRIGGER audit_company     ON company;
DROP TRIGGER audit_security    ON security;
DROP TRIGGER audit_listing     ON listing;
DROP TRIGGER audit_exchange    ON exchange;
DROP TRIGGER audit_asset_type  ON asset_type;
DROP TRIGGER audit_etf_profile ON etf_profile;
DROP TRIGGER audit_sector      ON sector;
DROP TRIGGER audit_industry    ON industry;

-- T4 en las 13 dimensiones mutables.
CREATE TRIGGER audit_company           AFTER INSERT OR UPDATE OR DELETE ON company           FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_security          AFTER INSERT OR UPDATE OR DELETE ON security          FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_listing           AFTER INSERT OR UPDATE OR DELETE ON listing           FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_exchange          AFTER INSERT OR UPDATE OR DELETE ON exchange          FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_asset_type        AFTER INSERT OR UPDATE OR DELETE ON asset_type        FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_etf_profile       AFTER INSERT OR UPDATE OR DELETE ON etf_profile       FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_sector            AFTER INSERT OR UPDATE OR DELETE ON sector            FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_industry          AFTER INSERT OR UPDATE OR DELETE ON industry          FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_validation_rule   AFTER INSERT OR UPDATE OR DELETE ON validation_rule   FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_source_exchange   AFTER INSERT OR UPDATE OR DELETE ON source_exchange   FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_source_venue_map  AFTER INSERT OR UPDATE OR DELETE ON source_venue_map  FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_source_holder_map AFTER INSERT OR UPDATE OR DELETE ON source_holder_map FOR EACH ROW EXECUTE FUNCTION audit_dimension();
CREATE TRIGGER audit_source_sector_map AFTER INSERT OR UPDATE OR DELETE ON source_sector_map FOR EACH ROW EXECUTE FUNCTION audit_dimension();

-- ---------------------------------------------------------------------------------------------------------------
-- 3. DATA_QUALITY_FINDING: target_row_id bigint -> target_key jsonb (misma razón: PK compuesta en prices_daily,
--    fx_rates, earnings, ownership_snapshot, analyst_consensus, short_interest, etf_snapshot...). Un solo finding
--    abierto por regla y objetivo, y el ciclo de vida atado a status.
-- ---------------------------------------------------------------------------------------------------------------
-- Aún no hay productores de findings. Si hubiera filas no habría forma general de reconstruir su clave.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM data_quality_finding) THEN
    RAISE EXCEPTION '013: data_quality_finding no está vacía; no se inventa el target_key de findings ya escritos';
  END IF;
END $$;

ALTER TABLE data_quality_finding ADD COLUMN target_key jsonb NOT NULL;
ALTER TABLE data_quality_finding DROP COLUMN target_row_id;  -- arrastra data_quality_finding_target_idx
ALTER TABLE data_quality_finding ADD CONSTRAINT data_quality_finding_target_key_is_object CHECK (jsonb_typeof(target_key) = 'object');
CREATE INDEX data_quality_finding_target_idx ON data_quality_finding (target_table, target_key);

-- open es el único estado pendiente; reviewed, accepted y dismissed lo cierran, y entonces resolved_at y resolved_by
-- tienen que estar informados. Un finding cerrado no se reabre: si el problema vuelve, es un finding nuevo.
ALTER TABLE data_quality_finding ADD CONSTRAINT data_quality_finding_resolved_at_iff_closed CHECK ((status = 'open') = (resolved_at IS NULL));
ALTER TABLE data_quality_finding ADD CONSTRAINT data_quality_finding_resolved_by_iff_closed CHECK ((status = 'open') = (resolved_by IS NULL));

-- Un solo finding ABIERTO por (regla, tabla objetivo, clave objetivo). El productor inserta con
-- ON CONFLICT (rule_code, target_table, target_key) WHERE status = 'open' DO UPDATE SET detail = EXCLUDED.detail.
CREATE UNIQUE INDEX data_quality_finding_one_open_idx ON data_quality_finding (rule_code, target_table, target_key) WHERE status = 'open';
