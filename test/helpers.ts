import type pg from 'pg';
import { pool } from '../src/db/pool.js';

// Ejecuta fn dentro de una transacción que siempre se revierte: cada test parte de BD limpia
// y no deja datos. Los errores esperados se capturan con expectDbError.
export async function inRollback<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

// Ejecuta sql dentro de un SAVEPOINT y devuelve el mensaje de error (o null si no falló),
// para poder seguir usando la transacción después de un error esperado.
export async function dbError(c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  await c.query('SAVEPOINT t');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT t');
    return null;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT t');
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
}
