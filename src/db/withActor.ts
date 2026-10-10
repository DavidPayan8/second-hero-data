import type pg from 'pg';
import { pool } from './pool.js';

// Abre una transacción, fija app.actor / app.reason con alcance de transacción
// (los lee el trigger de auditoría, T4) y ejecuta fn. Toda escritura del
// normalizador en dimensiones pasa por aquí.
export async function withActor<T>(
  actor: string,
  reason: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor', $1, true), set_config('app.reason', $2, true)", [actor, reason]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
