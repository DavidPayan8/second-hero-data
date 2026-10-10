import { migrate } from './migrate.js';
import { closePool } from './pool.js';

const applied = await migrate();
console.log(applied.length ? `Aplicadas: ${applied.join(', ')}` : 'Sin migraciones pendientes');
await closePool();
