-- 012_triggers: T1, T2 y T4. (T3 ya no existe: la consistencia sector/industria de COMPANY es una FK compuesta en 010.)
-- Spec: docs/modelo/decisiones-modelo-etf.md §1 (T1, T2) y decisiones-modelo-auditoria.md (T4).

-- ---------------------------------------------------------------------------------------------------------------
-- T1: SECURITY BEFORE INSERT/UPDATE. ASSET_TYPE.requires_company = true  => company_id NOT NULL;
--                                    ASSET_TYPE.requires_company = false => company_id NULL.
-- El invariante es cross-tabla (un CHECK solo ve su propia fila), por eso es un trigger. El comportamiento va como
-- dato en ASSET_TYPE.requires_company: un tipo de activo futuro se declara a sí mismo, sin tocar restricciones.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION security_check_company() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_requires boolean;
  v_code     text;
BEGIN
  SELECT requires_company, code INTO v_requires, v_code FROM asset_type WHERE asset_type_id = NEW.asset_type_id;
  IF v_requires AND NEW.company_id IS NULL THEN
    RAISE EXCEPTION 'security: el tipo de activo % exige company_id (requires_company = true)', v_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'security_requires_company';
  ELSIF NOT v_requires AND NEW.company_id IS NOT NULL THEN
    RAISE EXCEPTION 'security: el tipo de activo % no admite company_id (requires_company = false)', v_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'security_forbids_company';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER security_check_company BEFORE INSERT OR UPDATE ON security
  FOR EACH ROW EXECUTE FUNCTION security_check_company();

-- ---------------------------------------------------------------------------------------------------------------
-- T2: ASSET_TYPE BEFORE UPDATE. requires_company es inmutable una vez el tipo tiene securities: T1 no protege contra
-- un UPDATE que invalide filas ya existentes.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION asset_type_requires_company_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requires_company IS DISTINCT FROM OLD.requires_company
     AND EXISTS (SELECT 1 FROM security WHERE asset_type_id = OLD.asset_type_id) THEN
    RAISE EXCEPTION 'asset_type %: requires_company no se puede cambiar porque ya tiene securities', OLD.code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_type_requires_company_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER asset_type_requires_company_immutable BEFORE UPDATE ON asset_type
  FOR EACH ROW EXECUTE FUNCTION asset_type_requires_company_immutable();

-- ---------------------------------------------------------------------------------------------------------------
-- T4: auditoría de dimensiones. AFTER INSERT/UPDATE/DELETE, una fila en DIMENSION_AUDIT por columna que realmente
-- cambió (se compara OLD y NEW como texto con IS DISTINCT FROM, así NULL -> NULL no genera fila).
--   INSERT: una fila por columna con valor (old_value NULL).   DELETE: una fila por columna con valor (new_value NULL).
-- change_set_id: uno por transacción. Si la aplicación fijó app.change_set_id se respeta; si no, el trigger genera un
-- uuid y lo fija con set_config(..., true), de modo que los cambios de la misma transacción lo comparten.
-- changed_by y reason salen de app.actor y app.reason (withActor); NULL si no se aportan.
-- El nombre de la columna PK (bigint) se pasa como argumento del trigger.
-- Tablas auditadas aquí: las dimensiones con PK bigint. VALIDATION_RULE (PK rule_code, texto) y las cuatro SOURCE_*
-- (PK compuesta de texto) no caben en row_id bigint: propuesta P10, pendiente. Hasta decidirla no se auditan.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION audit_dimension() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_pk     text := TG_ARGV[0];
  v_old    jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  v_new    jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  v_op     text  := lower(TG_OP);
  v_cs     uuid  := nullif(current_setting('app.change_set_id', true), '')::uuid;
  v_actor  text  := nullif(current_setting('app.actor', true), '');
  v_reason text  := nullif(current_setting('app.reason', true), '');
  v_row_id bigint := ((CASE WHEN TG_OP = 'DELETE' THEN v_old ELSE v_new END) ->> v_pk)::bigint;
  v_col    text;
BEGIN
  IF v_cs IS NULL THEN
    v_cs := gen_random_uuid();
    PERFORM set_config('app.change_set_id', v_cs::text, true);
  END IF;
  FOR v_col IN SELECT jsonb_object_keys(v_old || v_new) LOOP
    IF (v_old ->> v_col) IS DISTINCT FROM (v_new ->> v_col) THEN
      INSERT INTO dimension_audit (change_set_id, table_name, row_id, column_name, old_value, new_value, op, changed_by, reason)
      VALUES (v_cs, TG_TABLE_NAME, v_row_id, v_col, v_old ->> v_col, v_new ->> v_col, v_op, v_actor, v_reason);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER audit_company    AFTER INSERT OR UPDATE OR DELETE ON company    FOR EACH ROW EXECUTE FUNCTION audit_dimension('company_id');
CREATE TRIGGER audit_security   AFTER INSERT OR UPDATE OR DELETE ON security   FOR EACH ROW EXECUTE FUNCTION audit_dimension('security_id');
CREATE TRIGGER audit_listing    AFTER INSERT OR UPDATE OR DELETE ON listing    FOR EACH ROW EXECUTE FUNCTION audit_dimension('listing_id');
CREATE TRIGGER audit_exchange   AFTER INSERT OR UPDATE OR DELETE ON exchange   FOR EACH ROW EXECUTE FUNCTION audit_dimension('exchange_id');
CREATE TRIGGER audit_asset_type AFTER INSERT OR UPDATE OR DELETE ON asset_type FOR EACH ROW EXECUTE FUNCTION audit_dimension('asset_type_id');
CREATE TRIGGER audit_etf_profile AFTER INSERT OR UPDATE OR DELETE ON etf_profile FOR EACH ROW EXECUTE FUNCTION audit_dimension('security_id');
CREATE TRIGGER audit_sector     AFTER INSERT OR UPDATE OR DELETE ON sector     FOR EACH ROW EXECUTE FUNCTION audit_dimension('sector_id');
CREATE TRIGGER audit_industry   AFTER INSERT OR UPDATE OR DELETE ON industry   FOR EACH ROW EXECUTE FUNCTION audit_dimension('industry_id');
