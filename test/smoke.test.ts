import { afterAll, expect, test } from 'vitest';
import { closePool, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { withActor } from '../src/db/withActor.js';

afterAll(closePool);

test('conecta a Postgres 16', async () => {
  const { rows } = await pool.query<{ v: string }>("SELECT current_setting('server_version') AS v");
  expect(rows[0]?.v).toMatch(/^16\./);
});

test('migrate funciona con cero migraciones y es idempotente', async () => {
  await migrate();
  expect(await migrate()).toEqual([]);
});

test('withActor fija app.actor y app.reason solo dentro de la transacción', async () => {
  const inside = await withActor('tester', 'smoke', async (c) => {
    const { rows } = await c.query("SELECT current_setting('app.actor', true) AS a, current_setting('app.reason', true) AS r");
    return rows[0];
  });
  expect(inside).toEqual({ a: 'tester', r: 'smoke' });
  const { rows } = await pool.query("SELECT current_setting('app.actor', true) AS a");
  expect(rows[0]?.a ?? '').toBe('');
});
