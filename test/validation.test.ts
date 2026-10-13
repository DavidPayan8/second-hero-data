import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { runValidation } from '../src/validation/runner.js';

// Runner de validación y reglas CURRENCY_COHERENCE, YOY_JUMP y STALENESS contra Postgres real, con datos sintéticos.
async function cleanAll() {
  for (const sql of [
    'DELETE FROM data_quality_finding', 'DELETE FROM fundamentals', 'DELETE FROM shares_outstanding', 'DELETE FROM prices_daily', 'DELETE FROM fx_rates',
    'DELETE FROM listing', 'DELETE FROM security', 'DELETE FROM company',
    "DELETE FROM dimension_audit WHERE table_name IN ('company', 'security', 'listing')",
    "UPDATE validation_rule SET enabled = true, default_severity = 'warning' WHERE rule_code IN ('YOY_JUMP', 'STALENESS')",
    "UPDATE validation_rule SET enabled = true, default_severity = 'error' WHERE rule_code = 'CURRENCY_COHERENCE'",
  ]) await pool.query(sql);
}
beforeAll(async () => { await migrate(); await seed(); });
afterAll(async () => { await cleanAll(); await closePool(); });
beforeEach(cleanAll);

let n = 0;
async function makeStock(opts: { quote?: string; mic?: string; status?: string } = {}) {
  n++;
  const company = (await pool.query<{ id: string }>("INSERT INTO company (legal_name, cik, identity_source) VALUES ($1, $2, 'cik') RETURNING company_id AS id", [`Empresa ${n}`, `000000${n}`.slice(-10)])).rows[0]!.id;
  const security = (await pool.query<{ id: string }>("INSERT INTO security (company_id, asset_type_id) VALUES ($1, (SELECT asset_type_id FROM asset_type WHERE code = 'common_stock')) RETURNING security_id AS id", [company])).rows[0]!.id;
  const listing = (await pool.query<{ id: string }>(
    "INSERT INTO listing (security_id, exchange_id, ticker, provider_symbol, quote_currency, status, is_primary_listing) VALUES ($1, (SELECT exchange_id FROM exchange WHERE mic = $2), $3, $4, $5, $6, true) RETURNING listing_id AS id",
    [security, opts.mic ?? 'XNAS', `T${n}`, `T${n}.US`, opts.quote ?? 'USD', opts.status ?? 'active'])).rows[0]!.id;
  return { company, security, listing };
}
async function fund(company: string, periodEnd: string, type: 'Q' | 'A', revenue: string | null, over: { reportedAt?: string; currency?: string } = {}) {
  await pool.query('INSERT INTO fundamentals (company_id, period_end, period_type, reported_at, reported_at_source, currency, revenue) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [company, periodEnd, type, over.reportedAt ?? periodEnd, 'provider', over.currency ?? 'USD', revenue]);
}
const findings = async (rule: string, status?: string) => (await pool.query(
  `SELECT finding_id::text AS id, severity, target_table, target_key, status, detail FROM data_quality_finding WHERE rule_code = $1 ${status ? 'AND status = $2' : ''} ORDER BY finding_id`, status ? [rule, status] : [rule])).rows;

describe('runner', () => {
  test('ejecuta solo las reglas activas con lógica, con la severidad del catálogo, y lista el resto', async () => {
    await pool.query("UPDATE validation_rule SET enabled = false WHERE rule_code = 'YOY_JUMP'");
    const s = await runValidation({ today: '2026-10-13' });
    expect(Object.keys(s.ran).sort()).toEqual(['CURRENCY_COHERENCE', 'SECOND_SOURCE_MISMATCH', 'STALENESS']);
    expect(s.disabled).toEqual(['YOY_JUMP']);
    expect(s.failed).toEqual({});
    expect(s.withoutLogic).toContain('SECTOR_UNMAPPED');
    expect(s.withoutLogic).not.toContain('ACCOUNTING_BALANCE'); // sigue apagada: ni se ejecuta ni se lista como activa
    expect(s.disabled).not.toContain('ACCOUNTING_BALANCE');
  });

  test('un fallo de una regla se recoge en el resumen y no impide las demás', async () => {
    const { RULE_IMPLS } = await import('../src/validation/runner.js');
    const original = RULE_IMPLS.STALENESS!;
    RULE_IMPLS.STALENESS = async () => { throw new Error('boom'); };
    try {
      const s = await runValidation({ today: '2026-10-13' });
      expect(s.failed).toEqual({ STALENESS: 'boom' });
      expect(Object.keys(s.ran)).toContain('YOY_JUMP');
    } finally { RULE_IMPLS.STALENESS = original; }
  });
});

describe('CURRENCY_COHERENCE', () => {
  const fx = (cur: string) => pool.query("INSERT INTO fx_rates (currency, date, units_per_base) VALUES ($1, '2026-10-09', 1.1)", [cur]);

  test('divisa de reporte sin camino de conversión: finding error sobre el listing, con la divisa que falta; con FX no hay finding', async () => {
    const { company, listing } = await makeStock({ quote: 'USD' });
    await fund(company, '2026-06-30', 'Q', '100', { currency: 'TWD' });
    await fx('USD');
    const s = await runValidation({ today: '2026-10-13', only: ['CURRENCY_COHERENCE'] });
    expect(s.ran.CURRENCY_COHERENCE).toMatchObject({ candidates: 1, inserted: 1 });
    const f = await findings('CURRENCY_COHERENCE');
    expect(f).toEqual([{ id: expect.any(String), severity: 'error', target_table: 'listing', target_key: { listing_id: Number(listing) }, status: 'open',
      detail: { quote_currency: 'USD', reporting_currencies: ['TWD'], without_fx_rates: ['TWD'] } }]);
    // con el tipo de cambio de TWD ya hay camino: el finding abierto sigue (lo cierra una persona) y no se emiten más
    await fx('TWD');
    const again = await runValidation({ today: '2026-10-13', only: ['CURRENCY_COHERENCE'] });
    expect(again.ran.CURRENCY_COHERENCE).toMatchObject({ candidates: 0, inserted: 0 });
    expect(await findings('CURRENCY_COHERENCE')).toHaveLength(1);
  });

  test('misma divisa de reporte y cotización, o la base EUR, no necesitan filas de FX', async () => {
    const a = await makeStock({ quote: 'USD' });
    await fund(a.company, '2026-06-30', 'Q', '100', { currency: 'USD' });
    const b = await makeStock({ quote: 'EUR', mic: 'XNYS' });
    await fund(b.company, '2026-06-30', 'Q', '100', { currency: 'EUR' });
    const c = await makeStock({ quote: 'USD' });
    await fund(c.company, '2026-06-30', 'Q', '100', { currency: 'EUR' });
    await fx('USD');
    const s = await runValidation({ today: '2026-10-13', only: ['CURRENCY_COHERENCE'] });
    expect(s.ran.CURRENCY_COHERENCE).toMatchObject({ candidates: 0 }); // EUR es la base: factor 1
  });

  test('un listing delisted o no primario no se evalúa', async () => {
    const { company, listing } = await makeStock({ quote: 'USD', status: 'delisted' });
    await fund(company, '2026-06-30', 'Q', '100', { currency: 'TWD' });
    expect((await runValidation({ today: '2026-10-13', only: ['CURRENCY_COHERENCE'] })).ran.CURRENCY_COHERENCE).toMatchObject({ candidates: 0 });
    await pool.query("UPDATE listing SET status = 'active', is_primary_listing = false WHERE listing_id = $1", [listing]);
    expect((await runValidation({ today: '2026-10-13', only: ['CURRENCY_COHERENCE'] })).ran.CURRENCY_COHERENCE).toMatchObject({ candidates: 0 });
  });
});

describe('reglas de emisión de findings', () => {
  test('validar dos veces no duplica; un finding cerrado con el mismo detail no se re-emite; si el detail cambia, es uno nuevo y el cerrado queda', async () => {
    const { company } = await makeStock();
    await fund(company, '2025-06-30', 'Q', '100');
    await fund(company, '2026-06-30', 'Q', '500');
    const run = () => runValidation({ today: '2026-10-13', only: ['YOY_JUMP'] });
    expect((await run()).ran.YOY_JUMP).toMatchObject({ candidates: 1, inserted: 1 });
    expect((await run()).ran.YOY_JUMP).toMatchObject({ candidates: 1, inserted: 0, updated: 0, unchanged: 1 });
    expect(await findings('YOY_JUMP')).toHaveLength(1);
    // se acepta: ya no se re-emite aunque el problema siga
    await pool.query("UPDATE data_quality_finding SET status = 'accepted', resolved_at = now(), resolved_by = 'david'");
    expect((await run()).ran.YOY_JUMP).toMatchObject({ candidates: 1, inserted: 0, suppressed: 1 });
    expect(await findings('YOY_JUMP', 'open')).toHaveLength(0);
    // los datos cambian (el proveedor corrige el ingreso actual): el detail es otro, finding nuevo; el aceptado queda como historia
    await pool.query("UPDATE fundamentals SET revenue = 600 WHERE period_end = '2026-06-30'");
    expect((await run()).ran.YOY_JUMP).toMatchObject({ inserted: 1, suppressed: 0 });
    expect((await findings('YOY_JUMP')).map((f) => f.status)).toEqual(['accepted', 'open']);
    // y si cambia otra vez con el abierto sin revisar: se actualiza su detail, no se duplica
    await pool.query("UPDATE fundamentals SET revenue = 700 WHERE period_end = '2026-06-30'");
    expect((await run()).ran.YOY_JUMP).toMatchObject({ inserted: 0, updated: 1 });
    expect((await findings('YOY_JUMP', 'open'))[0]!.detail).toMatchObject({ current: 700 });
  });

  test('la severidad efectiva es la del catálogo en el momento de emitir', async () => {
    const { company } = await makeStock();
    await fund(company, '2025-06-30', 'Q', '100');
    await fund(company, '2026-06-30', 'Q', '500');
    await pool.query("UPDATE validation_rule SET default_severity = 'error' WHERE rule_code = 'YOY_JUMP'");
    await runValidation({ today: '2026-10-13', only: ['YOY_JUMP'] });
    expect((await findings('YOY_JUMP'))[0]).toMatchObject({ severity: 'error' });
  });
});

describe('YOY_JUMP', () => {
  test('ingresos con una variación de más del 200 % frente al mismo periodo del año anterior: warning sobre la fila actual', async () => {
    const { company } = await makeStock();
    await fund(company, '2025-06-30', 'Q', '100');
    await fund(company, '2026-06-30', 'Q', '301'); // +201 %
    await fund(company, '2025-09-30', 'Q', '100');
    await fund(company, '2026-09-30', 'Q', '299'); // +199 %: dentro
    await fund(company, '2025-12-31', 'Q', '0');
    await fund(company, '2026-12-31', 'Q', '500'); // el anterior es 0: no se compara
    const id = (await pool.query<{ id: string }>("SELECT fundamentals_id AS id FROM fundamentals WHERE period_end = '2026-06-30'")).rows[0]!.id;
    await runValidation({ today: '2027-01-15', only: ['YOY_JUMP'] });
    const f = await findings('YOY_JUMP');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', target_table: 'fundamentals', target_key: { fundamentals_id: Number(id) },
      detail: { metric: 'revenue', period_end: '2026-06-30', current: 301, prior_period_end: '2025-06-30', prior: 100 } });
  });

  test('compara la versión más reciente de cada periodo, solo con la misma divisa y tolerando unos días de desfase del cierre', async () => {
    const { company } = await makeStock();
    await fund(company, '2025-06-30', 'Q', '100');
    await fund(company, '2025-06-30', 'Q', '1000', { reportedAt: '2025-09-01' }); // reexpresado: manda esta versión
    await fund(company, '2026-06-27', 'Q', '2500'); // cierre unos días antes: +150 % contra 1000 -> dentro
    await fund(company, '2025-03-31', 'Q', '100', { currency: 'EUR' });
    await fund(company, '2026-03-31', 'Q', '900'); // otra divisa en el anterior: no comparables
    await runValidation({ today: '2027-01-15', only: ['YOY_JUMP'] });
    expect(await findings('YOY_JUMP')).toHaveLength(0);
  });

  test('acciones en circulación', async () => {
    const { security } = await makeStock();
    await pool.query("INSERT INTO shares_outstanding (security_id, period_end, reported_at, reported_at_source, shares) VALUES ($1,'2025-06-30','2025-07-30','provider',1000), ($1,'2026-06-30','2026-07-30','provider',4000), ($1,'2025-09-30','2025-10-30','provider',1000), ($1,'2026-09-30','2026-10-30','provider',2500)", [security]);
    await runValidation({ today: '2027-01-15', only: ['YOY_JUMP'] });
    const f = await findings('YOY_JUMP');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ target_table: 'shares_outstanding', detail: { metric: 'shares', period_end: '2026-06-30', current: 4000, prior: 1000 } });
  });
});

describe('STALENESS', () => {
  const price = (listing: string, d: string) => pool.query('INSERT INTO prices_daily (listing_id, date, close) VALUES ($1, $2, 10)', [listing, d]);

  test('fundamentales viejos (más de 200 días) o último precio con más de 5 días hábiles: warning sobre la security, con la última fecha y no los días', async () => {
    const stale = await makeStock();
    await fund(stale.company, '2026-03-31', 'Q', '100', { reportedAt: '2026-04-20' });
    await price(stale.listing, '2026-09-28'); // lunes
    const fresh = await makeStock();
    await fund(fresh.company, '2026-06-30', 'Q', '100', { reportedAt: '2026-07-30' });
    await price(fresh.listing, '2026-10-12');
    const run = (today: string) => runValidation({ today, only: ['STALENESS'] });
    // 2026-10-13: fundamentales de hace 176 días y precio con 11 días naturales (11 hábiles: del 29/09 al 13/10) -> solo el precio
    await run('2026-10-13');
    let f = await findings('STALENESS');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', target_table: 'security', target_key: { security_id: Number(stale.security) }, detail: { last_price: '2026-09-28' } });
    // más tarde caen también los fundamentales; el detail del precio no cambia con los días
    await run('2026-11-20');
    f = await findings('STALENESS');
    expect(f.filter((x) => x.target_key.security_id === Number(stale.security))).toHaveLength(1);
    expect((await findings('STALENESS', 'open')).find((x) => x.target_key.security_id === Number(stale.security))!.detail).toEqual({ last_fundamentals: '2026-04-20', last_price: '2026-09-28' });
  });

  test('el detail no depende del día del pase: repetir otro día con los mismos datos no actualiza nada', async () => {
    const { listing } = await makeStock();
    await price(listing, '2026-09-01');
    expect((await runValidation({ today: '2026-10-13', only: ['STALENESS'] })).ran.STALENESS).toMatchObject({ inserted: 1 });
    expect((await runValidation({ today: '2026-10-20', only: ['STALENESS'] })).ran.STALENESS).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
  });

  test('los fines de semana no cuentan como días hábiles; sin precios o fundamentales no hay "último" y no se evalúa', async () => {
    const a = await makeStock();
    await price(a.listing, '2026-10-09'); // viernes: el martes 13 lleva 2 hábiles (lunes y martes)
    await makeStock(); // sin precios ni fundamentales
    expect((await runValidation({ today: '2026-10-13', only: ['STALENESS'] })).ran.STALENESS).toMatchObject({ candidates: 0 });
    expect((await runValidation({ today: '2026-10-16', only: ['STALENESS'] })).ran.STALENESS).toMatchObject({ candidates: 0 }); // viernes 16: 5 hábiles, aún no supera el umbral
    expect((await runValidation({ today: '2026-10-19', only: ['STALENESS'] })).ran.STALENESS).toMatchObject({ candidates: 1 }); // lunes 19: 6 hábiles
  });
});

describe('cierre automático de findings de estado', () => {
  const price = (listing: string, d: string) => pool.query('INSERT INTO prices_daily (listing_id, date, close) VALUES ($1, $2, 10)', [listing, d]);
  const closedByRunner = async (rule: string) => (await pool.query("SELECT finding_id FROM data_quality_finding WHERE rule_code = $1 AND status = 'dismissed' AND resolved_by = 'runner' AND resolved_at IS NOT NULL", [rule])).rows;

  test('STALENESS que se corrige con datos nuevos: una pasada completa la cierra como dismissed por el runner; una parcial no cierra nada', async () => {
    const { listing } = await makeStock();
    await price(listing, '2026-09-01');
    await runValidation({ today: '2026-10-13', only: ['STALENESS'] });
    expect(await findings('STALENESS', 'open')).toHaveLength(1);
    await price(listing, '2026-10-12'); // datos nuevos: ya no está obsoleto
    const partial = await runValidation({ today: '2026-10-13', only: ['STALENESS'] });
    expect(partial.ran.STALENESS).toMatchObject({ closed: 0 });
    expect(await findings('STALENESS', 'open')).toHaveLength(1);
    const full = await runValidation({ today: '2026-10-13' });
    expect(full.ran.STALENESS).toMatchObject({ closed: 1 });
    expect(await findings('STALENESS', 'open')).toHaveLength(0);
    expect(await closedByRunner('STALENESS')).toHaveLength(1);
    // idempotente: otra pasada completa no cierra nada más
    expect((await runValidation({ today: '2026-10-13' })).ran.STALENESS).toMatchObject({ closed: 0 });
  });

  test('si la condición vuelve a cumplirse con el mismo detail, el cierre del runner no la suprime: finding nuevo (uno cerrado por una persona sí suprime)', async () => {
    const { company } = await makeStock({ quote: 'USD' });
    await fund(company, '2026-06-30', 'Q', '100', { currency: 'TWD' });
    await pool.query("INSERT INTO fx_rates (currency, date, units_per_base) VALUES ('USD', '2026-10-09', 1.1)");
    await runValidation({ today: '2026-10-13' });
    expect(await findings('CURRENCY_COHERENCE', 'open')).toHaveLength(1);
    await pool.query("INSERT INTO fx_rates (currency, date, units_per_base) VALUES ('TWD', '2026-10-09', 30)");
    await runValidation({ today: '2026-10-13' });
    expect(await findings('CURRENCY_COHERENCE', 'open')).toHaveLength(0);
    await pool.query("DELETE FROM fx_rates WHERE currency = 'TWD'");
    await runValidation({ today: '2026-10-13' });
    expect((await findings('CURRENCY_COHERENCE')).map((f) => f.status)).toEqual(['dismissed', 'open']);
    // lo cierra una persona y el estado sigue igual: no se re-emite
    await pool.query("UPDATE data_quality_finding SET status = 'accepted', resolved_at = now(), resolved_by = 'david' WHERE status = 'open'");
    await runValidation({ today: '2026-10-13' });
    expect(await findings('CURRENCY_COHERENCE', 'open')).toHaveLength(0);
  });

  test('un finding de evento del normalizador (CORPORATE_EVENT_CHANGED) nunca se cierra solo, ni en pasada completa', async () => {
    const { listing } = await makeStock();
    await pool.query("INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detail) VALUES ('CORPORATE_EVENT_CHANGED', 'warning', 'listing', jsonb_build_object('listing_id', $1::bigint), '{}')", [listing]);
    await runValidation({ today: '2026-10-13' });
    await runValidation({ today: '2026-10-13' });
    expect(await findings('CORPORATE_EVENT_CHANGED', 'open')).toHaveLength(1);
  });

  test('YOY_JUMP solo mira periodos de los últimos 3 años: uno antiguo no se emite y el abierto que hubiera lo cierra el runner', async () => {
    const { company } = await makeStock();
    await fund(company, '2019-06-30', 'Q', '100');
    await fund(company, '2020-06-30', 'Q', '900'); // salto real pero fuera de alcance
    await fund(company, '2025-06-30', 'Q', '100');
    await fund(company, '2026-06-30', 'Q', '900'); // dentro de alcance
    // un aviso antiguo que ya estaba abierto (de antes de acotar la regla)
    const old = (await pool.query<{ id: string }>("SELECT fundamentals_id AS id FROM fundamentals WHERE period_end = '2020-06-30'")).rows[0]!.id;
    await pool.query(
      "INSERT INTO data_quality_finding (rule_code, severity, target_table, target_key, detail) VALUES ('YOY_JUMP', 'warning', 'fundamentals', jsonb_build_object('fundamentals_id', $1::bigint), jsonb_build_object('metric', 'revenue'))", [old]);
    const s = await runValidation({ today: '2026-10-13' });
    expect(s.ran.YOY_JUMP).toMatchObject({ candidates: 1, inserted: 1, closed: 1 });
    const open = await findings('YOY_JUMP', 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.detail).toMatchObject({ period_end: '2026-06-30' });
    expect(await closedByRunner('YOY_JUMP')).toHaveLength(1);
  });
});
