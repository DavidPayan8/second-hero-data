import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from './test/test-db.js';

// Los tests corren contra una base propia (<base>_test), nunca contra la de desarrollo: los escritores confirman
// datos y la base de desarrollo guarda payloads reales capturados. global-setup.ts la crea, migra y siembra.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    globalSetup: ['test/global-setup.ts'],
    env: { DATABASE_URL: testDatabaseUrl() },
  },
});
