import 'dotenv/config';

export const config = {
  eodhdApiKey: process.env.EODHD_API_KEY ?? '',
  eodhdBase: 'https://eodhd.com/api',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://second_hero:second_hero@localhost:5432/second_hero',
  // Captura. Tope de coste por corrida: el plan Free da 20 llamadas al día, así que por defecto se para en 15 y deja margen.
  runBudget: Number(process.env.EODHD_RUN_BUDGET ?? 15),
  timeoutMs: Number(process.env.EODHD_TIMEOUT_MS ?? 30_000),
  maxAttempts: Number(process.env.EODHD_MAX_ATTEMPTS ?? 1),
  retryDelayMs: Number(process.env.EODHD_RETRY_DELAY_MS ?? 2_000),
};
