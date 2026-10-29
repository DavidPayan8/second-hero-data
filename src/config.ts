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
  // 2ª fuente: la SEC (data.sec.gov, sin token). Exige un User-Agent con nombre y contacto (SEC_USER_AGENT en .env).
  secUserAgent: (process.env.SEC_USER_AGENT ?? '').trim(),
  secBase: 'https://data.sec.gov',
  // Panel web (src/admin). ADMIN_USERS = "david=<hash>,alberto=<hash>" (hashes de `npm run admin-hash -- <clave>`).
  // En Azure App Service el puerto llega en PORT y hay que escuchar en 0.0.0.0 (ADMIN_HOST).
  adminUsers: process.env.ADMIN_USERS ?? '',
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET ?? '',
  adminPort: Number(process.env.PORT ?? process.env.ADMIN_PORT ?? 3000),
  adminHost: process.env.ADMIN_HOST ?? '127.0.0.1',
};
