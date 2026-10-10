import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, pool } from './pool.js';

const dir = 'db/migrations';

// Runner mínimo: aplica en orden los .sql numerados que falten, cada uno en su
// transacción, y registra nombre + sha256 en schema_migrations. Si un fichero ya
// aplicado cambió, aborta: una migración aplicada no se edita.
export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Map((await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations')).rows.map((r) => [r.name, r.sha256]));
    const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(f);
      if (prev) {
        if (prev !== hash) throw new Error(`La migración ${f} ya estaba aplicada y ha cambiado`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [f, hash]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falló ${f}: ${(err as Error).message}`);
      }
      applied.push(f);
    }
    return applied;
  } finally {
    client.release();
  }
}
