import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './pool.js';

const dir = 'db/seeds';

// Aplica en orden los .sql de db/seeds, cada uno en su transacción. Los seeds son idempotentes
// (ON CONFLICT), así que se pueden relanzar. Requiere las migraciones ya aplicadas.
export async function seed(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    for (const f of readdirSync(dir).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falló el seed ${f}: ${(err as Error).message}`);
      }
      applied.push(f);
    }
    return applied;
  } finally {
    client.release();
  }
}
