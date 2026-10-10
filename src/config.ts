import 'dotenv/config';

export const config = {
  eodhdApiKey: process.env.EODHD_API_KEY ?? '',
  eodhdBase: 'https://eodhd.com/api',
  fixturesDir: 'fixtures/eodhd',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://second_hero:second_hero@localhost:5432/second_hero',
  dailyBudget: Number(process.env.EODHD_DAILY_BUDGET ?? 20),
};
