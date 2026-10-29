import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESION_MAX_MS = 12 * 3600 * 1000;
const KEYLEN = 32;
// Hash de relleno: un usuario inexistente cuesta lo mismo que uno real (no revela quién existe).
const RELLENO = `scrypt$${'00'.repeat(16)}$${'00'.repeat(KEYLEN)}`;

export function hashPassword(clave: string): string {
  const sal = randomBytes(16);
  return `scrypt$${sal.toString('hex')}$${scryptSync(clave, sal, KEYLEN).toString('hex')}`;
}

// "david=<hash>,alberto=<hash>". El hash solo lleva letras, dígitos y '$', así que ',' y '=' separan sin ambigüedad.
export function parseUsers(env: string | undefined): Map<string, string> {
  const users = new Map<string, string>();
  for (const parte of (env ?? '').split(',')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    const usuario = parte.slice(0, i).trim();
    const hash = parte.slice(i + 1).trim();
    if (usuario && hash.startsWith('scrypt$')) users.set(usuario, hash);
  }
  return users;
}

function comprobar(hash: string, clave: string): boolean {
  const [alg, salHex, hashHex] = hash.split('$');
  if (alg !== 'scrypt' || !salHex || !hashHex || !/^[0-9a-f]+$/.test(salHex + hashHex) || hashHex.length !== KEYLEN * 2) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  return timingSafeEqual(scryptSync(clave, Buffer.from(salHex, 'hex'), KEYLEN), esperado);
}

export function verificarClave(users: Map<string, string>, usuario: string, clave: string): boolean {
  const hash = users.get(usuario);
  const ok = comprobar(hash ?? RELLENO, clave);
  return hash !== undefined && clave !== '' && ok;
}

const firma = (datos: string, secret: string): string => createHmac('sha256', secret).update(datos).digest('base64url');

// Cookie = base64url("<expira>|<usuario>") + "." + firma. La fecha va primero: el usuario puede contener '|'.
export function firmarSesion(usuario: string, secret: string, ahora: number = Date.now()): string {
  const datos = Buffer.from(`${ahora + SESION_MAX_MS}|${usuario}`).toString('base64url');
  return `${datos}.${firma(datos, secret)}`;
}

export function leerSesion(cookie: string | undefined, secret: string, ahora: number = Date.now()): string | null {
  if (!cookie) return null;
  const i = cookie.lastIndexOf('.');
  if (i < 0) return null;
  const datos = cookie.slice(0, i);
  const recibida = Buffer.from(cookie.slice(i + 1));
  const esperada = Buffer.from(firma(datos, secret));
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null;
  const texto = Buffer.from(datos, 'base64url').toString('utf8');
  const j = texto.indexOf('|');
  if (j < 0) return null;
  const expira = Number(texto.slice(0, j));
  const usuario = texto.slice(j + 1);
  if (!Number.isFinite(expira) || ahora > expira || !usuario) return null;
  return usuario;
}
