# Panel web de revisión ESEF y visor de payload — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App web (`npm run admin`) para decidir los candidatos `esef_lei_isin` y ver `payload_blob` descomprimido, desplegada en Azure para David y Alberto, más los comandos que sincronizan las decisiones con la BD local.

**Architecture:** Servidor Node con `node:http` y `pg`, sin dependencias nuevas. La lógica vive en módulos puros o con acceso a BD (`src/admin/*.ts`) que se prueban contra Postgres real; el servidor solo enruta; el front es HTML + JS + CSS estáticos en `src/admin/public/`. La sincronización Azure/local son dos comandos de `src/esef/sync.ts`.

**Tech Stack:** Node 22, TypeScript strict, `pg`, `node:crypto` (scrypt, HMAC), `node:zlib` (zstd), vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-panel-esef-design.md`

## Global Constraints

- Sin dependencias nuevas en `package.json`.
- Sin migración ni tabla nueva (el spec las descarta). No tocar `company` ni `security`.
- Estado de una fila de `esef_lei_isin`: `accepted` (Vincular), `rejected` (Rechazar), `proposed` (Pendiente). El CHECK exige `reviewed_by` y `reviewed_at` NULL si y solo si `status = 'proposed'`.
- Filas `reviewed_by = 'auto'` (las 246 automáticas) no se editan desde la app.
- `reviewed_by` sale de la sesión, nunca del cuerpo de la petición.
- El servidor escucha en `127.0.0.1` salvo que `PORT` y `HOST` lo cambien en Azure; toda ruta `/api/*` salvo `/api/login` exige sesión.
- Tope del visor: 20 MiB descomprimidos (`VIEWER_MAX_BYTES`, único sitio).
- Tests contra Postgres real en la BD `_test`; estilo de `test/esef-identify.test.ts` (`inRollback`, `dbError` de `test/helpers.ts`).
- Commits en español, terminan con `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Nunca commitear `.env`, `fixtures/` ni contraseñas.
- Texto del usuario y de la BD se inserta en el DOM con `textContent`, nunca `innerHTML`.

## Review Focus

- Clave vacía, usuario inexistente o cookie manipulada: 401, sin detalle de cuál falló. (Task 4, Task 5)
- Decisión con valor distinto de `accepted|rejected|proposed`, o sobre un par (lei, isin) que no existe: 400/404, sin escribir. (Task 2)
- Intentar editar una fila `auto`: se rechaza sin cambiar nada. (Task 2)
- Dos personas deciden la misma fila a la vez: gana la última escritura y la respuesta devuelve el estado final. (Task 2)
- Blob cuyo sha256 descomprimido no coincide con `content_hash`, `body_format` desconocido o cuerpo que no es JSON: el visor lo dice, no se cae. (Task 3)
- Cuerpo descomprimido mayor que el tope: aviso, no se devuelve el cuerpo. (Task 3)
- `esef-pull-reviews` no pisa una fila local más reciente ni una `auto` con otra `auto`. (Task 6)
- `matched_name` con `<script>` o comillas se ve como texto. (Task 7)

---

## File Structure

- Create `src/admin/avisos.ts` — avisos "Sugerido"/"Revisar" (puro).
- Create `src/admin/review.ts` — consultas y escrituras de `esef_lei_isin`.
- Create `src/admin/viewer.ts` — búsqueda y apertura de `payload_blob`.
- Create `src/admin/auth.ts` — hash de clave, usuarios por entorno, cookie firmada.
- Create `src/admin/server.ts` — rutas HTTP y estáticos.
- Create `src/admin/public/{index.html,app.js,style.css}` — front.
- Create `src/esef/sync.ts` — `planPush`, `planPull`, `pushCandidates`, `pullReviews`.
- Modify `src/cli.ts`, `package.json` — comandos `admin`, `admin-hash`, `esef-push-candidates`, `esef-pull-reviews`.
- Create `test/admin-*.test.ts`, `test/esef-sync.test.ts`.
- Create `docs/admin-azure.md` — rol `sh_review`, variables, despliegue, resincronización sin la tabla.

---

### Task 1: Avisos "Sugerido" y "Revisar"

**Files:**
- Create: `src/admin/avisos.ts`
- Test: `test/admin-avisos.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Aviso = 'sugerido' | 'revisar';
  export interface FilaAviso { lei: string; isin: string; matchedType: string | null; country: string | null }
  export function avisoDe(fila: FilaAviso, hermanas: FilaAviso[]): { aviso: Aviso; motivo: string }
  ```
  `hermanas` = las demás filas del mismo LEI. `motivo` es el texto corto en español que verá el usuario.

- [ ] **Step 1: Write the failing tests** (puros, sin BD), con estos casos:
  - `avisoDe({isin:'ES0113900J37', country:'GB', type Common Stock}, [US05964H1059])` → `revisar` si el prefijo `ES` ≠ país `GB`; usar país `ES` para el caso Sugerido sin hermana con mismo prefijo.
  - Santander con país `ES`: `ES0113900J37` → `sugerido`; `US05964H1059` → `revisar` y `motivo` contiene `ADR`.
  - Volvo con país `SE`: `SE0000115420` y `SE0000115446` → ambos `revisar` y `motivo` contiene `otra clase`.
  - Ariston: `NL0015000N33`, país `IT` → `revisar` y `motivo` contiene `prefijo`.
  - `matchedType: 'Preferred Stock'` con prefijo = país y sin hermanas → `revisar`.
  - `country: null` → `revisar`.
- [ ] **Step 2: Run** `npx vitest run test/admin-avisos.test.ts` → FAIL (módulo no existe).
- [ ] **Step 3: Implement `avisoDe`.** Reglas del spec: `revisar` si (ISIN empieza por `US` y país ≠ `US`) → motivo con "ADR"; o si alguna hermana tiene el mismo prefijo de 2 letras → "otra clase de acciones"; o si prefijo ≠ país o país nulo → "prefijo del ISIN distinto del país del informe"; o si tipo ≠ `Common Stock`. En otro caso `sugerido`.
- [ ] **Step 4: Run** el mismo comando → PASS.
- [ ] **Step 5: Commit** `git add src/admin/avisos.ts test/admin-avisos.test.ts` — «Panel ESEF: avisos Sugerido y Revisar».

---

### Task 2: Capa de revisión (consultas y decisiones)

**Files:**
- Create: `src/admin/review.ts`
- Test: `test/admin-review.test.ts`

**Interfaces:**
- Consumes: `avisoDe`, `FilaAviso` (Task 1); `pool` de `src/db/pool.ts`.
- Produces:
  ```ts
  export type Decision = 'accepted' | 'rejected' | 'proposed';
  export interface FilaRevision { isin: string; symbol: string | null; type: string | null; name: string | null;
    status: Decision; reviewedBy: string | null; reviewedAt: string | null; aviso: Aviso; motivo: string }
  export interface EmpresaRevision { lei: string; country: string | null; filas: FilaRevision[] }
  export class RevisionError extends Error { constructor(public status: 400|404|409, msg: string) }
  export function listar(c: Queryable, opts?: { soloPendientes?: boolean }): Promise<{ empresas: EmpresaRevision[]; resumen: {pendientes:number; aceptadas:number; rechazadas:number; auto:number} }>
  export function decidir(c: Queryable, lei: string, isin: string, decision: Decision, usuario: string): Promise<FilaRevision>
  export function aplicarSugerencias(c: Queryable, usuario: string): Promise<{ cambiadas: number }>
  ```
  `Queryable` = `pg.Pool | pg.PoolClient`. `listar` incluye solo empresas con alguna fila no `auto`; las filas `auto` se omiten.

- [ ] **Step 1: Write the failing tests** (`inRollback`, sembrar `esef_filing` mínimo con `country` y filas de `esef_lei_isin`; usar los datos de Santander y Volvo del spec):
  - `listar` devuelve empresas con filas, `aviso` rellenado, resumen con conteos.
  - `decidir(…, 'accepted', 'david')` deja `status='accepted'`, `reviewed_by='david'`, `reviewed_at` no nulo.
  - `decidir(…, 'proposed', …)` deja `reviewed_by` y `reviewed_at` NULL.
  - Valor inválido → `RevisionError` 400; par inexistente → 404; fila con `reviewed_by='auto'` → 409; ninguna escritura en los tres casos.
  - `aplicarSugerencias` cambia a `accepted` solo filas `proposed` con aviso `sugerido`; no toca `revisar`, ni `rejected`, ni `auto`; devuelve el número.
- [ ] **Step 2: Run** `npx vitest run test/admin-review.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `listar`: un `SELECT` de `esef_lei_isin` con `LEFT JOIN LATERAL` al `country` de `esef_filing` por LEI (el máximo por `period_end`), agrupar en memoria. `decidir`: validar valor, `UPDATE … WHERE lei=$1 AND isin=$2 AND reviewed_by IS DISTINCT FROM 'auto' RETURNING`; si 0 filas, distinguir 404/409 con un `SELECT`. Para `proposed` escribir NULL en ambos campos.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — «Panel ESEF: consultas y decisiones sobre esef_lei_isin».

---

### Task 3: Visor de payload

**Files:**
- Create: `src/admin/viewer.ts`
- Test: `test/admin-viewer.test.ts`

**Interfaces:**
- Consumes: `decodeBody` de `src/esef/codec.ts`; tablas `payload_blob` (`content_hash`, `body`, `body_format`, `size_bytes`) y `raw_payload`.
- Produces:
  ```ts
  export const VIEWER_MAX_BYTES = 20 * 1024 * 1024;
  export interface BlobResumen { contentHash: string; bodyFormat: string; sizeBytes: number; source: string | null; endpoint: string | null; fetchedAt: string | null }
  export function buscar(c: Queryable, q: string, limit?: number): Promise<BlobResumen[]>
  export function abrir(c: Queryable, contentHash: string): Promise<{ resumen: BlobResumen; hashOk: boolean; json: unknown }>
  export class VisorError extends Error { constructor(public status: 400|404|413|422, msg: string) }
  ```
  Antes de implementar, leer `db/migrations/010_normalizador.sql` para los nombres exactos de columnas de `raw_payload` (fuente, endpoint, fecha) y ajustar `BlobResumen`.

- [ ] **Step 1: Write the failing tests:** blob `json+zstd` creado con `compressBody` y `json` plano se abren y devuelven el objeto; `hashOk` es `true` con sha256 correcto y `false` si el `content_hash` no coincide con el contenido; `body_format='raro'` → `VisorError` 422; cuerpo no JSON → 422; `size_bytes` mayor que `VIEWER_MAX_BYTES` → 413 sin descomprimir; hash inexistente → 404; `buscar` por prefijo de hash y por texto de endpoint; `q` vacío → 400.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `buscar` con `LIKE $1 || '%'` sobre hash y `ILIKE` sobre endpoint/fuente, parametrizado, `limit` por defecto 50. `abrir`: comprobar `size_bytes` contra el tope antes de `decodeBody`; calcular sha256 de los bytes descomprimidos.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — «Panel ESEF: visor de payload_blob».

---

### Task 4: Acceso (claves y sesión)

**Files:**
- Create: `src/admin/auth.ts`
- Test: `test/admin-auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function hashPassword(clave: string): string            // "scrypt$<saltHex>$<hashHex>"
  export function parseUsers(env: string | undefined): Map<string, string>   // "david=<hash>,alberto=<hash>"
  export function verificarClave(users: Map<string,string>, usuario: string, clave: string): boolean
  export function firmarSesion(usuario: string, secret: string, ahora?: number): string
  export function leerSesion(cookie: string | undefined, secret: string, ahora?: number): string | null
  export const SESION_MAX_MS = 12 * 3600 * 1000;
  ```
  El hash lleva `$` y no `,` ni `=` dentro del valor hex para que `parseUsers` separe bien por `,` y primer `=`.

- [ ] **Step 1: Write the failing tests:** `verificarClave` acepta la clave correcta y rechaza una incorrecta, vacía o de usuario inexistente (mismo `false` en los tres); `parseUsers` ignora entradas vacías o mal formadas; `leerSesion(firmarSesion('david', s), s)` → `'david'`; cookie con un carácter cambiado → `null`; cookie firmada con otro secreto → `null`; cookie pasada de `SESION_MAX_MS` → `null`; `undefined` → `null`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** con `crypto.scryptSync`, `timingSafeEqual` y HMAC-SHA256; cookie = `base64url(usuario|expira)` + `.` + firma. Para usuario inexistente, hacer igualmente una derivación scrypt falsa para no variar el tiempo.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — «Panel ESEF: claves con scrypt y sesión firmada».

---

### Task 5: Servidor HTTP

**Files:**
- Create: `src/admin/server.ts`
- Modify: `src/config.ts` (añadir `adminUsers`, `adminSessionSecret`, `adminPort`, `adminHost`)
- Test: `test/admin-server.test.ts`

**Interfaces:**
- Consumes: `listar`, `decidir`, `aplicarSugerencias`, `RevisionError` (Task 2); `buscar`, `abrir`, `VisorError` (Task 3); `parseUsers`, `verificarClave`, `firmarSesion`, `leerSesion` (Task 4).
- Produces: `export function crearServidor(opts: { db: Queryable; users: Map<string,string>; secret: string }): http.Server`.
- Rutas (JSON salvo estáticos): `POST /api/login {usuario,clave}` → cookie `sh_sesion` HttpOnly, SameSite=Strict (Secure si `NODE_ENV=production`); `POST /api/logout`; `GET /api/me`; `GET /api/revision?soloPendientes=1`; `POST /api/revision/decision {lei,isin,decision}`; `POST /api/revision/sugerencias`; `GET /api/blobs?q=`; `GET /api/blobs/:hash`; `GET /` y `GET /static/*` desde `src/admin/public/`.
  Los POST exigen cabecera `Content-Type: application/json` (defensa contra CSRF junto a SameSite).

- [ ] **Step 1: Write the failing tests** arrancando `crearServidor` en puerto 0 con `fetch`: `/api/revision` sin cookie → 401; login con clave mala → 401 con cuerpo idéntico al de usuario inexistente; login correcto → cookie y luego `/api/me` devuelve el usuario; `POST decision` guarda con `reviewed_by` igual al usuario de la sesión aunque el cuerpo traiga `reviewedBy:'otro'`; errores `RevisionError` salen con su estado; `/api/blobs/:hash` con tope superado → 413; POST sin `application/json` → 415; ruta estática con `..` → 404.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** el enrutado a mano (tabla de rutas, una función `manejar` con `try/catch` que traduce `RevisionError`/`VisorError` a su estado y cualquier otro error a 500 sin detalle). Servir estáticos solo desde la carpeta `public/` con `path.resolve` y comprobación de prefijo. Añadir en `src/cli.ts` el comando `admin` (lee config, `listen(adminPort, adminHost)`), y en `package.json` los scripts `admin` y `admin-hash` (este último imprime `hashPassword` de la clave pasada por argumento). Valores por defecto: puerto `3000`, host `127.0.0.1`.
- [ ] **Step 4: Run** → PASS, y `npm run typecheck` sin errores.
- [ ] **Step 5: Commit** — «Panel ESEF: servidor HTTP con login y rutas».

---

### Task 6: Sincronización Azure / local

**Files:**
- Create: `src/esef/sync.ts`
- Modify: `src/cli.ts`, `package.json` (scripts `esef-push-candidates`, `esef-pull-reviews`)
- Test: `test/esef-sync.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FilaLeiIsin { lei: string; isin: string; source: string; matchedSymbol: string|null; matchedType: string|null; matchedName: string|null;
    status: 'proposed'|'accepted'|'rejected'; reviewedBy: string|null; reviewedAt: string|null; generatedAt: string }
  export function planPush(local: FilaLeiIsin[], remoto: FilaLeiIsin[]): FilaLeiIsin[]      // filas locales cuyo (lei,isin) no existe en remoto
  export function planPull(remoto: FilaLeiIsin[], local: FilaLeiIsin[]): FilaLeiIsin[]      // filas remotas que deben escribirse en local
  export function pushCandidates(local: Queryable, remoto: Queryable): Promise<{ insertadas: number }>
  export function pullReviews(remoto: Queryable, local: Queryable): Promise<{ actualizadas: number }>
  ```
  `pullReviews` y `pushCandidates` leen/escriben con SQL parametrizado; la lógica de decisión está solo en los `plan*` (puros).
  Regla de `planPull` (spec): escribir en local la fila remota si (a) remota está revisada por una persona (`reviewedBy` ≠ `auto` y ≠ null) o ha vuelto a `proposed` tras haber estado revisada, y (b) local no es más reciente (`reviewedAt` local > remota ⇒ no se pisa; empate o local `auto`/`proposed` ⇒ se escribe). Una vuelta a `proposed` en remoto solo se propaga si local está revisada por una persona. Filas ausentes en local se insertan.
  La URL de la BD remota sale de `AZURE_DATABASE_URL` en `.env` (con `sslmode=require`); el comando falla con mensaje claro si falta.

- [ ] **Step 1: Write the failing tests** de `planPush`/`planPull` puros (local más reciente no se pisa; remota humana pisa a local `auto`; vuelta a `proposed` remota pisa a local humana; remota `auto` nunca pisa; fila ausente en local se inserta; fila idéntica no genera cambio) y de `pushCandidates`/`pullReviews` contra el Postgres de test usando dos transacciones sobre la misma BD como «local» y «remoto» (cada una con su propio `BEGIN`/`ROLLBACK`; si no cabe, probar solo la parte SQL con `inRollback` y filas ya sembradas).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `plan*` y las dos funciones; `pushCandidates` usa `INSERT … ON CONFLICT DO NOTHING`; `pullReviews` usa upsert que respeta el CHECK (para `proposed` escribe `reviewed_by` y `reviewed_at` NULL). Añadir ramas al CLI con el patrón de `esef-identify` (dry-run sin `--go`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — «ESEF: comandos para subir candidatos y traer revisiones».

---

### Task 7: Front (revisión y visor)

**Files:**
- Create: `src/admin/public/index.html`, `app.js`, `style.css`
- Test: manual con checklist (no hay framework de front en el repo)

**Interfaces:**
- Consumes: rutas de Task 5. Maquetas aprobadas: `.superpowers/brainstorm/…/content/decision-v2.html` (opción A) en el directorio temporal de la sesión; si ya no existe, reproducirla desde la descripción del spec.
- Produces: pantalla de login; pestañas «Revisión» y «Visor»; barra de progreso («Progreso: N de M») y botón «Aplicar sugerencias» con confirmación; por empresa una tarjeta con nombre/LEI/país y por fila ISIN, símbolo, tipo, aviso con su motivo y el interruptor «Pendiente · Vincular · Rechazar» (verde/rojo); bajo cada fila la frase de ayuda: «Vincular: este ISIN es una acción de esta empresa y se guarda. Rechazar: no lo es, y no vuelve a proponerse. Pendiente: aún sin decidir.»; visor con búsqueda, metadatos, indicador de hash correcto, árbol plegable, vista texto y vista tabla (solo si la raíz es un array de objetos), copiar y descargar .json.

- [ ] **Step 1: Escribir `index.html` y `style.css`** con el diseño de la maqueta A (tarjetas, interruptor de 3 estados con colores, barra de progreso).
- [ ] **Step 2: Escribir `app.js`:** `fetch` a las rutas, 401 → vuelve al login; cada clic del interruptor llama a `POST /api/revision/decision` y repinta la fila con la respuesta; todo texto de BD con `textContent`.
- [ ] **Step 3: Verificar a mano** con `npm run admin`: login, decidir una fila y comprobar con SQL que `status`, `reviewed_by`, `reviewed_at` cambian; volver a Pendiente deja los dos campos en NULL; una fila con `matched_name` `<b>x</b>` (insertada temporalmente en una transacción de prueba o en la BD de test) se ve como texto; abrir un `json+zstd` real y uno `json`.
- [ ] **Step 4: Commit** — «Panel ESEF: pantalla de revisión y visor».

---

### Task 8: Azure y documentación

**Files:**
- Create: `docs/admin-azure.md`
- Modify: memoria `second-hero-azure-dev.md` (sin contraseñas)

**Interfaces:** acciones sobre la cuenta Azure de David; **cada paso que crea o cambia recursos se confirma con David antes de ejecutarlo.**

- [ ] **Step 1: Documentar y, con confirmación, crear el rol** `sh_review` en Azure (LOGIN, clave aleatoria guardada en `C:\Users\MIGUEL\.second-hero-azure.txt`): SELECT en `esef_lei_isin`, `esef_filing`, `payload_blob`, `raw_payload`; UPDATE en `esef_lei_isin`. Verificar que `sh_review` no puede escribir en otra tabla.
- [ ] **Step 2: Cambiar el procedimiento de resincronización** a `pg_dump --exclude-table=esef_lei_isin` (así el `--clean` del restore no la toca) y documentarlo. Primero hacer `pushCandidates` para que Azure tenga las 272 filas antes de excluirla (con `pg_restore` hecho el 2026-10-28 ya las tiene).
- [ ] **Step 3: Con confirmación, crear App Service F1 (Node 22)**, definir variables `DATABASE_URL` (rol `sh_review`, `sslmode=require`), `ADMIN_USERS` (hashes de David y Alberto generados con `npm run admin-hash`), `ADMIN_SESSION_SECRET`, `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT` si Azure lo exige; desplegar con zip (`az webapp deploy`). Pasar a Container Apps solo si F1 falla, avisando a David.
- [ ] **Step 4: Verificar en la URL pública:** login de David, decidir una fila de prueba y volverla a Pendiente, abrir un blob; `npm run esef-pull-reviews` trae el cambio a local.
- [ ] **Step 5: Dar a Alberto** la URL y su clave por un canal que elija David; actualizar la memoria y commitear — «Panel ESEF: despliegue en Azure y resincronización sin esef_lei_isin».

---

## Self-review

- **Cobertura del spec:** pantalla de revisión (T1, T2, T5, T7), visor (T3, T5, T7), acceso y `reviewed_by` por sesión (T4, T5), rol y grants (T8), push/pull (T6), resincronización sin la tabla y alojamiento (T8), avisos con las reglas del spec (T1), Aplicar sugerencias con confirmación (T2, T7), historial perdido al volver a Pendiente (comportamiento natural de T2).
- **Tipos:** `Decision`, `Aviso`, `Queryable`, `FilaLeiIsin` se definen en la tarea que los produce y se usan con el mismo nombre en las siguientes.
- **Riesgo conocido:** T6 depende de poder simular dos BD en los tests; si no cabe, los `plan*` puros cubren la lógica y el SQL se prueba por separado.
