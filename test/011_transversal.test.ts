import type pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { dbError, inRollback } from './helpers.js';

beforeAll(async () => { await migrate(); await seed(); });
afterAll(closePool);

const id = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;

test('A1: existen exactamente las 36 tablas del modelo (sin contar schema_migrations)', async () => {
  const modelo = [
    // núcleo
    'asset_type', 'exchange', 'sector', 'industry', 'company', 'security', 'listing', 'listing_ticker_change',
    'fundamentals', 'shares_outstanding', 'prices_daily', 'fx_rates', 'stock_split', 'dividend', 'earnings',
    // ownership
    'holder_position', 'insider_transaction', 'ownership_snapshot', 'analyst_consensus', 'short_interest',
    // etf
    'etf_profile', 'etf_snapshot', 'etf_holding', 'etf_allocation',
    // noticias
    'news', 'news_security',
    // normalizador
    'ingestion_run', 'payload_blob', 'raw_payload', 'source_exchange', 'source_venue_map', 'source_holder_map', 'source_sector_map',
    // transversal
    'dimension_audit', 'validation_rule', 'data_quality_finding',
  ].sort();
  expect(modelo).toHaveLength(36);
  const { rows } = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY 1");
  expect(rows.map((r) => r.table_name)).toEqual(modelo);
});

const AUD = "INSERT INTO dimension_audit (change_set_id, table_name, row_key, column_name, old_value, new_value, op) VALUES (gen_random_uuid(),'company','{\"company_id\": 1}','legal_name',$1,$2,$3)";

test('dimension_audit: op en dominio, obligatorios, valores texto, sin FK', () => inRollback(async (c) => {
  for (const op of ['insert', 'update', 'delete', 'merge']) await c.query(AUD, [null, 'x', op]);
  expect((await dbError(c, AUD, ['a', 'b', 'upsert']))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO dimension_audit (table_name, row_key, column_name, op) VALUES ('company','{\"company_id\": 1}','x','update')"))?.code).toBe('23502'); // sin change_set_id
  expect((await dbError(c, "INSERT INTO dimension_audit (change_set_id, row_key, column_name, op) VALUES (gen_random_uuid(),'{\"company_id\": 1}','x','update')"))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO dimension_audit (change_set_id, table_name, column_name, op) VALUES (gen_random_uuid(),'company','x','update')"))?.code).toBe('23502');
  const { rows } = await c.query('SELECT changed_at IS NOT NULL AS ok, changed_by, reason FROM dimension_audit LIMIT 1');
  expect(rows[0]).toEqual({ ok: true, changed_by: null, reason: null });
  // polimórfica a propósito: apunta a una fila que no existe y no pasa nada
  await c.query("INSERT INTO dimension_audit (change_set_id, table_name, row_key, column_name, op) VALUES (gen_random_uuid(),'tabla_que_no_existe','{\"id\": 999999}','x','delete')");
  const fks = await pool.query("SELECT 1 FROM pg_constraint WHERE contype='f' AND (conrelid='dimension_audit'::regclass OR confrelid='dimension_audit'::regclass)");
  expect(fks.rows).toEqual([]);
}));

const RULE = "INSERT INTO validation_rule (rule_code, description, category, default_severity) VALUES ($1,'d',$2,$3)";

test('validation_rule: PK rule_code, category y default_severity en dominio, enabled por defecto true', () => inRollback(async (c) => {
  await c.query(RULE, ['R_TEST', 'structural', 'info']);
  expect((await dbError(c, RULE, ['R_TEST', 'structural', 'info']))?.code).toBe('23505');
  expect((await dbError(c, RULE, ['R2', 'otra', 'info']))?.code).toBe('23514');
  expect((await dbError(c, RULE, ['R3', 'structural', 'fatal']))?.code).toBe('23514');
  expect((await dbError(c, 'INSERT INTO validation_rule (rule_code, category, default_severity) VALUES ($1,$2,$3)', ['R4', 'structural', 'info']))?.code).toBe('23502'); // sin description
  expect((await c.query("SELECT enabled FROM validation_rule WHERE rule_code='R_TEST'")).rows[0].enabled).toBe(true);
}));

test('seed validation_rule: catálogo de 15 reglas; ACCOUNTING_BALANCE desactivada (D4); VENUE_UNMAPPED y ASSET_TYPE_UNMAPPED structural warning (D6)', async () => {
  const { rows } = await pool.query<{ rule_code: string; category: string; default_severity: string; enabled: boolean }>('SELECT rule_code, category, default_severity, enabled FROM validation_rule ORDER BY 1');
  const by = Object.fromEntries(rows.map((r) => [r.rule_code, r]));
  expect(rows).toHaveLength(15);
  expect(by.ACCOUNTING_BALANCE?.enabled).toBe(false);
  expect(rows.filter((r) => !r.enabled).map((r) => r.rule_code)).toEqual(['ACCOUNTING_BALANCE']);
  for (const code of ['VENUE_UNMAPPED', 'ASSET_TYPE_UNMAPPED']) expect(by[code], code).toMatchObject({ category: 'structural', default_severity: 'warning' });
  expect(by.IDENTITY_RELINK_CONFLICT?.default_severity).toBe('error');
  expect(by.CORPORATE_EVENT_CHANGED).toMatchObject({ category: 'data_quality', default_severity: 'warning' });
  expect(by.DIVIDEND_SAME_EX_DATE).toMatchObject({ category: 'structural', default_severity: 'warning' });
  for (const code of ['CURRENCY_COHERENCE', 'YOY_JUMP', 'SECOND_SOURCE_MISMATCH', 'STALENESS', 'IDENTITY_ISOLATED', 'HOLDER_UNMAPPED', 'SECTOR_UNMAPPED']) expect(by[code], code).toBeDefined();
});

test('el seed de validation_rule no revierte cambios operativos al relanzarse', async () => {
  await pool.query("UPDATE validation_rule SET enabled=false, default_severity='error' WHERE rule_code='YOY_JUMP'");
  try {
    await seed();
    expect((await pool.query("SELECT enabled, default_severity FROM validation_rule WHERE rule_code='YOY_JUMP'")).rows[0]).toEqual({ enabled: false, default_severity: 'error' });
  } finally {
    await pool.query("UPDATE validation_rule SET enabled=true, default_severity='warning' WHERE rule_code='YOY_JUMP'");
  }
});

const F = "INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key) VALUES ($1,$2,$3,$4::jsonb)";

test('data_quality_finding: FK a la regla, severity y status en dominio, defaults y sin FK al objetivo', () => inRollback(async (c) => {
  await c.query(F, ['VENUE_UNMAPPED', 'warning', 'listing', '{"listing_id": 123456}']); // la fila no existe y no hace falta
  const row = (await c.query('SELECT status, detail, detected_at IS NOT NULL AS d, detected_by_run, resolved_at, resolved_by FROM data_quality_finding')).rows[0];
  expect(row).toEqual({ status: 'open', detail: null, d: true, detected_by_run: null, resolved_at: null, resolved_by: null });
  expect((await dbError(c, F, ['REGLA_INEXISTENTE', 'warning', 'listing', '{"listing_id": 1}']))?.code).toBe('23503');
  expect((await dbError(c, F, ['YOY_JUMP', 'critical', 'listing', '{"listing_id": 1}']))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, status) VALUES ('YOY_JUMP','warning','listing','{\"a\":1}','cerrado')"))?.code).toBe('23514');
  expect((await dbError(c, "INSERT INTO data_quality_finding (rule_code, severity, target_key) VALUES ('YOY_JUMP','warning','{\"a\":1}')"))?.code).toBe('23502');
  expect((await dbError(c, "INSERT INTO data_quality_finding (rule_code, severity, target_table) VALUES ('YOY_JUMP','warning','listing')"))?.code).toBe('23502');
  // severity efectiva puede diferir del default de la regla (YOY_JUMP es warning por defecto)
  await c.query(F, ['YOY_JUMP', 'error', 'security', '{"security_id": 2}']);
  // detail jsonb y corrida
  const run = await id(c, "INSERT INTO ingestion_run (provider, scope) VALUES ('eodhd','eod:US') RETURNING ingestion_run_id AS id");
  await c.query("INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detail, detected_by_run) VALUES ('CORPORATE_EVENT_CHANGED','warning','dividend','{\"dividend_id\": 9}',$1,$2)", [{ old: 0.27, new: 0.28 }, run]);
  expect((await c.query("SELECT detail->>'new' AS n FROM data_quality_finding WHERE target_table='dividend'")).rows[0].n).toBe('0.28');
  expect((await dbError(c, "INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detected_by_run) VALUES ('YOY_JUMP','warning','security','{\"security_id\": 1}',999999)"))?.code).toBe('23503');
  expect((await dbError(c, "DELETE FROM validation_rule WHERE rule_code='VENUE_UNMAPPED'"))?.code).toBe('23503');
}));
