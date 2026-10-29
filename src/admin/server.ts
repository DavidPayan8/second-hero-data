import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firmarSesion, leerSesion, SESION_MAX_MS, verificarClave } from './auth.js';
import { aplicarSugerencias, decidir, listar, RevisionError, type Decision, type Queryable } from './review.js';
import { abrir, buscar, VisorError } from './viewer.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const COOKIE = 'sh_sesion';
const MAX_BODY = 64 * 1024;
const TIPOS: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// PROVISIONAL: único sitio con el límite de intentos de login fallidos por IP.
const LOGIN_MAX_FALLOS = 10;
const LOGIN_VENTANA_MS = 15 * 60 * 1000;

export interface OpcionesServidor { db: Queryable; users: Map<string, string>; secret: string }

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const enviar = (res: http.ServerResponse, status: number, cuerpo: unknown, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(cuerpo));
};

async function leerJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'se espera application/json');
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const t of req) {
    total += (t as Buffer).length;
    if (total > MAX_BODY) throw new HttpError(413, 'cuerpo demasiado grande');
    trozos.push(t as Buffer);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(trozos).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch { throw new HttpError(400, 'JSON no válido'); }
}

const cookieDe = (req: http.IncomingMessage): string | undefined =>
  (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

const atributosCookie = (): string => `Path=/; HttpOnly; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

async function estatico(res: http.ServerResponse, nombre: string): Promise<void> {
  const ruta = path.resolve(PUBLIC_DIR, nombre);
  const tipo = TIPOS[path.extname(ruta)];
  if (!tipo || !ruta.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'no encontrado');
  let datos: Buffer;
  try { datos = await readFile(ruta); } catch { throw new HttpError(404, 'no encontrado'); }
  res.writeHead(200, { 'content-type': tipo, 'cache-control': 'no-cache' });
  res.end(datos);
}

export function crearServidor(opts: OpcionesServidor): http.Server {
  const { db, users, secret } = opts;
  const fallos = new Map<string, number[]>();

  const manejar = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const metodo = req.method ?? 'GET';
    const ruta = url.pathname;

    if (metodo === 'GET' && (ruta === '/' || ruta === '/index.html')) return estatico(res, 'index.html');
    if (metodo === 'GET' && ruta.startsWith('/static/')) {
      let nombre: string;
      try { nombre = decodeURIComponent(ruta.slice('/static/'.length)); } catch { throw new HttpError(404, 'no encontrado'); }
      return estatico(res, nombre);
    }
    if (!ruta.startsWith('/api/')) throw new HttpError(404, 'no encontrado');

    if (metodo === 'POST' && ruta === '/api/login') {
      const ip = req.socket.remoteAddress ?? '?';
      const ahora = Date.now();
      const recientes = (fallos.get(ip) ?? []).filter((t) => ahora - t < LOGIN_VENTANA_MS);
      if (recientes.length >= LOGIN_MAX_FALLOS) throw new HttpError(429, 'demasiados intentos, espera unos minutos');
      const b = await leerJson(req);
      const usuario = typeof b.usuario === 'string' ? b.usuario : '';
      const clave = typeof b.clave === 'string' ? b.clave : '';
      if (!verificarClave(users, usuario, clave)) {
        fallos.set(ip, [...recientes, ahora]);
        throw new HttpError(401, 'usuario o clave incorrectos');
      }
      return enviar(res, 200, { usuario }, { 'set-cookie': `${COOKIE}=${firmarSesion(usuario, secret)}; ${atributosCookie()}; Max-Age=${SESION_MAX_MS / 1000}` });
    }
    if (metodo === 'POST' && ruta === '/api/logout') return enviar(res, 200, {}, { 'set-cookie': `${COOKIE}=; ${atributosCookie()}; Max-Age=0` });

    const usuario = leerSesion(cookieDe(req), secret);
    if (!usuario) throw new HttpError(401, 'hace falta iniciar sesión');

    if (metodo === 'GET' && ruta === '/api/me') return enviar(res, 200, { usuario });
    if (metodo === 'GET' && ruta === '/api/revision') return enviar(res, 200, await listar(db, { soloPendientes: url.searchParams.get('soloPendientes') === '1' }));
    if (metodo === 'POST' && ruta === '/api/revision/decision') {
      const b = await leerJson(req);
      if (typeof b.lei !== 'string' || typeof b.isin !== 'string' || typeof b.decision !== 'string') throw new HttpError(400, 'faltan lei, isin o decision');
      return enviar(res, 200, await decidir(db, b.lei, b.isin, b.decision as Decision, usuario));
    }
    if (metodo === 'POST' && ruta === '/api/revision/sugerencias') {
      await leerJson(req);
      return enviar(res, 200, await aplicarSugerencias(db, usuario));
    }
    if (metodo === 'GET' && ruta === '/api/blobs') return enviar(res, 200, await buscar(db, url.searchParams.get('q') ?? ''));
    const blob = /^\/api\/blobs\/([^/]+)$/.exec(ruta);
    if (metodo === 'GET' && blob) return enviar(res, 200, await abrir(db, blob[1]!));
    throw new HttpError(404, 'no encontrado');
  };

  return http.createServer((req, res) => {
    manejar(req, res).catch((e: unknown) => {
      if (e instanceof HttpError || e instanceof RevisionError || e instanceof VisorError) return enviar(res, e.status, { error: e.message });
      console.error(e);
      return enviar(res, 500, { error: 'error interno' });
    });
  });
}
