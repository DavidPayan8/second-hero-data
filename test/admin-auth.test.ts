import { describe, expect, test } from 'vitest';
import { firmarSesion, hashPassword, leerSesion, parseUsers, SESION_MAX_MS, verificarClave } from '../src/admin/auth.js';

const SECRETO = 'secreto-de-prueba-largo-y-aleatorio';

describe('claves', () => {
  const users = parseUsers(`david=${hashPassword('clave-david')},alberto=${hashPassword('clave-alberto')}`);
  test('la clave correcta entra; incorrecta, vacía y usuario inexistente dan false', () => {
    expect(verificarClave(users, 'david', 'clave-david')).toBe(true);
    expect(verificarClave(users, 'alberto', 'clave-alberto')).toBe(true);
    expect(verificarClave(users, 'david', 'clave-alberto')).toBe(false);
    expect(verificarClave(users, 'david', '')).toBe(false);
    expect(verificarClave(users, 'nadie', 'clave-david')).toBe(false);
  });
  test('dos hashes de la misma clave son distintos (sal) y ambos verifican', () => {
    const a = hashPassword('x1');
    const b = hashPassword('x1');
    expect(a).not.toBe(b);
    expect(verificarClave(new Map([['u', a]]), 'u', 'x1')).toBe(true);
    expect(verificarClave(new Map([['u', b]]), 'u', 'x1')).toBe(true);
  });
  test('parseUsers ignora entradas vacías o mal formadas', () => {
    const h = hashPassword('k');
    const m = parseUsers(`,sinigual,=${h},david=${h},otro=,  `);
    expect([...m.keys()]).toEqual(['david']);
    expect(parseUsers(undefined).size).toBe(0);
  });
  test('un hash corrupto no lanza: da false', () => {
    expect(verificarClave(new Map([['u', 'scrypt$zz$zz']]), 'u', 'k')).toBe(false);
    expect(verificarClave(new Map([['u', 'basura']]), 'u', 'k')).toBe(false);
  });
});

describe('sesión', () => {
  test('ida y vuelta', () => {
    expect(leerSesion(firmarSesion('david', SECRETO), SECRETO)).toBe('david');
  });
  test('cookie manipulada, con otro secreto, caducada o ausente -> null', () => {
    const c = firmarSesion('david', SECRETO, 1_000);
    const cambiada = c.replace(/^./, (ch) => (ch === 'a' ? 'b' : 'a'));
    expect(leerSesion(cambiada, SECRETO, 1_000)).toBeNull();
    expect(leerSesion(c, 'otro-secreto', 1_000)).toBeNull();
    expect(leerSesion(c, SECRETO, 1_000 + SESION_MAX_MS + 1)).toBeNull();
    expect(leerSesion(c, SECRETO, 1_000 + SESION_MAX_MS - 1)).toBe('david');
    expect(leerSesion(undefined, SECRETO)).toBeNull();
    expect(leerSesion('', SECRETO)).toBeNull();
    expect(leerSesion('sin-punto', SECRETO)).toBeNull();
  });
  test('un nombre de usuario con separadores no se confunde con la fecha', () => {
    expect(leerSesion(firmarSesion('a|b', SECRETO), SECRETO)).toBe('a|b');
  });
});
