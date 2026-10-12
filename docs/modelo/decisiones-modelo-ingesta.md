# Decisiones de diseño — Ingesta / Normalizador (payload crudo)

Primera pieza del **normalizador** (la fase proveedor → fuente de verdad). Cubre el payload crudo y el registro de corridas de ingesta. No es fuente de verdad: es la capa *anterior*, lo que llega del proveedor antes de parsear.

Estado: **payload crudo cerrado**. Pendientes del normalizador: datos de referencia (EXCHANGE/MIC), resolución de identidad, log de correcciones.

---

## 0. Qué es y para qué

El payload crudo guarda la respuesta del proveedor **tal cual llegó**, antes de parsear. Sirve para:
- **Auditar:** "¿qué nos mandó EODHD exactamente el día X?" cuando un dato no cuadra.
- **Reprocesar:** si cambiamos una regla de parseo, re-derivar desde el crudo sin volver a llamar a la API.

Es la capa anterior a la fuente de verdad. Dirección del flujo: **proveedor → crudo → (resolución de identidad) → fuente de verdad**. El crudo no sabe que la fuente de verdad existe.

---

## 1. Grano: una fila por llamada a la API

`RAW_PAYLOAD` = una fila por *request* (endpoint + símbolo/exchange + params + respuesta). Es la unidad natural de "lo que trajo una llamada". Una ingesta diaria de un mercado son miles de filas. (Decisión: grano por-llamada, al menos en v1.)

**Llamadas sin respuesta (2026-10-12, migración 010):** un fallo de transporte (timeout, conexión cortada, DNS) también es una fila: la llamada existió, y el orquestador necesita saber qué símbolos reintentar. En esa fila `http_status`, `content_hash` y `parse_status` son NULL (no hay cuerpo que guardar ni que parsear) y `transport_error` lleva el mensaje. CHECK: los cuatro van a la vez, o hay respuesta (`http_status`, `content_hash`, `parse_status` NOT NULL, `transport_error` NULL) o no la hay (al revés). Una respuesta HTTP de error (404, 429, 500) **sí** es respuesta: tiene cuerpo, se guarda en `PAYLOAD_BLOB` y lleva su `http_status`.

- `parse_error` NOT NULL **si y solo si** `parse_status = 'error'`.
- `INGESTION_RUN.finished_at` NULL si y solo si `status = 'running'`. Una corrida cuyo proceso muere se queda en `running`: el orquestador (Fase 3) la cierra como `failed` al arrancar la siguiente del mismo `scope`.

---

## 2. Corrida de ingesta como padre: `INGESTION_RUN`

Las llamadas se agrupan en **corridas** (la ingesta diaria de un mercado). Un padre ligero `INGESTION_RUN` responde "¿terminó la ingesta de US hoy?" y es **lo que el materializador consulta para dispararse al cierre de cada mercado** (recordatorio: materialización disparada por cierre de mercado, no por reloj global).

- `scope` identifica qué cubre la corrida (p. ej. `eod:US`, `fundamentals:XETRA`).
- `status`: running | ok | partial | failed. `partial` = terminó pero con errores en algunas llamadas.

---

## 3. Desacople total de la fuente de verdad (decisión clave)

`RAW_PAYLOAD` **NO tiene FK a SECURITY/LISTING/ninguna entidad de la fuente de verdad.** Cuando llega `AAPL.US`, todavía no se sabe qué `security_id` es — eso lo decide la resolución de identidad *después*. El crudo se identifica por sí mismo (`id` propio) y guarda `provider_symbol` como **texto**. La fuente de verdad podrá apuntar hacia atrás al crudo (trazabilidad), nunca al revés.

Respeta la dirección del flujo y evita el problema del huevo y la gallina (no puedes exigir un `security_id` que aún no existe cuando insertas el crudo).

---

## 4. Cuerpo direccionado por contenido: `PAYLOAD_BLOB` (blob separado)

El cuerpo crudo se separa en su propia tabla, con PK = `content_hash` (hash del cuerpo). `RAW_PAYLOAD.content_hash` apunta ahí. Muchas filas de `RAW_PAYLOAD` → un `PAYLOAD_BLOB`.

**Se descartó** guardar el cuerpo inline en `RAW_PAYLOAD` con una marca de duplicado: regüardaría cuerpos idénticos (EODHD devuelve lo mismo días seguidos, sobre todo en fundamentales) y mezclaría el dato purgable con la metadata eterna.

Lo que resuelve de golpe:
- **Dedup:** respuestas idénticas comparten `content_hash` → el cuerpo se guarda una sola vez (almacenamiento direccionado por contenido).
- **Retención:** purgar = `body = NULL` + `purged_at` en `PAYLOAD_BLOB`. **La metadata de `RAW_PAYLOAD` sobrevive para siempre** (quién, cuándo, qué endpoint, qué hash, qué parse_status): sabes que la llamada existió y qué devolvió aunque el cuerpo ya no esté.

---

## 5. Retención: configurable; metadata fija para siempre

- **Metadata** (`RAW_PAYLOAD` entero + `PAYLOAD_BLOB` sin el body) → **para siempre**, nunca se purga.
- **Cuerpo** (`PAYLOAD_BLOB.body`) → **retención configurable** (p. ej. 12 meses). Su valor —reprocesar/auditar— decae con el tiempo. Es una política operativa, no cambia el esquema.
- **Export:** opción de volcar `RAW_PAYLOAD` (+ el body si sigue vivo) a Excel/CSV. Es una **operación del pipeline**, no una tabla. Útil para auditar o archivar antes de purgar.

---

## 6. Idempotencia de la ingesta

La re-ingesta de la misma llamada no debe duplicar basura: el `content_hash` hace la inserción de cuerpo idempotente (si el hash ya existe en `PAYLOAD_BLOB`, no se reinserta el body). Cada intento sí deja su fila en `RAW_PAYLOAD` (son eventos distintos: dos llamadas, aunque devuelvan lo mismo), lo cual es correcto para auditoría.

---

## Pendiente de este chunk / del normalizador

- **Datos de referencia:** EXCHANGE con mapa código-proveedor↔MIC + resolución sub-exchange `.US`, seed de ASSET_TYPE. (Siguiente.)
- **Resolución de identidad:** `provider_symbol` → `security_id`/`listing_id`; anclado de `holder_ref`; ISIN→security de constituyentes de ETF.
- **Log de correcciones** sobre tablas de dimensión.
- **Verificar en vivo:** forma exacta de params/headers por endpoint de EODHD (para `endpoint`/`params`), y si conviene guardar también los response headers (rate-limit, etc.).
