import { closePool } from './pool.js';
import { seed } from './seed.js';

console.log(`Seeds aplicados: ${(await seed()).join(', ') || 'ninguno'}`);
await closePool();
