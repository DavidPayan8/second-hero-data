import 'dotenv/config';

export const config = {
  eodhdApiKey: process.env.EODHD_API_KEY ?? '',
  eodhdBase: 'https://eodhd.com/api',
  fixturesDir: 'fixtures/eodhd',
  dailyBudget: Number(process.env.EODHD_DAILY_BUDGET ?? 20),
};
