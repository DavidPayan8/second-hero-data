import pg from 'pg';
import { adminDatabaseUrl, testDatabaseUrl } from './test-db.js';

// Crea la base de test si no existe y le aplica migraciones y seeds. Se ejecuta una vez por corrida de vitest.
export default async function setup(): Promise<void> {
  const testUrl = testDatabaseUrl();
  const dbName = new URL(testUrl).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(dbName)) throw new Error(`Nombre de base de test no válido: ${dbName}`);

  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  // Los módulos de la aplicación leen DATABASE_URL al importarse: se fija antes de importarlos.
  process.env.DATABASE_URL = testUrl;
  const { migrate } = await import('../src/db/migrate.js');
  const { seed } = await import('../src/db/seed.js');
  const { closePool } = await import('../src/db/pool.js');
  await migrate();
  await seed();
  await closePool();
}
