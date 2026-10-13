// URL de la base de test: la de DATABASE_URL con el nombre de la base terminado en _test.
// Se evalúa también en el proceso principal de vitest, antes de que existan los workers.
const DEFAULT_URL = 'postgres://second_hero:second_hero@localhost:5432/second_hero';

export function devDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_URL;
}

export function testDatabaseUrl(): string {
  const url = new URL(devDatabaseUrl());
  const name = url.pathname.replace(/^\//, '');
  url.pathname = '/' + (name.endsWith('_test') ? name : `${name}_test`);
  return url.toString();
}

export function adminDatabaseUrl(): string {
  const url = new URL(devDatabaseUrl());
  url.pathname = '/postgres';
  return url.toString();
}
