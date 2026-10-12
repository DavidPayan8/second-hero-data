# Plan de construcción — capa de datos (sin VISTAS)

Cinco fases en orden. Cada una tiene pasos, un entregable y criterios de aceptación que se ejecutan antes de darla por cerrada. Las referencias a `docs/modelo/…` son la especificación; este plan dice **en qué orden** y **cómo se comprueba**, no repite el esquema.

| Fase | Qué | Necesita red a EODHD |
|---|---|---|
| 0 | Arranque del proyecto | No |
| 1 | Verificación en vivo contra EODHD (★ CIK/LEI primero) | Sí |
| 2 | Base de datos: migraciones, triggers, seeds | No |
| 3 | Normalizador: captura, referencia, identidad, taxonomía, escritores | Sí (captura) |
| 4 | Validación: reglas + cross-check SEC EDGAR | Sí (SEC) |
| 5 | Prueba de ingesta extremo a extremo | No (replay) |

La Fase 2 puede avanzar en paralelo a la 1. Los escritores de la Fase 3 de cada bloque esperan a que ese bloque esté verificado en la Fase 1.

---

## Fase 0 — Arranque

1. `package.json` (Node 22, TypeScript `strict`, `vitest`, `pg`, `dotenv`), `tsconfig.json`.
2. `docker-compose.yml` con `postgres:16` y volumen persistente. `DATABASE_URL` en `.env` (copiar de `.env.example`).
3. Estructura:
   ```
   db/migrations/      001_…sql (numeradas)
   db/seeds/           datos de referencia
   src/config.ts
   src/db/             pool, migrate.ts (runner propio, tabla schema_migrations), withActor()
   src/eodhd/          client.ts, endpoints.ts, capture.ts
   src/normalizer/     ingest.ts, reference.ts, identity.ts, taxonomy.ts, writers/
   src/validation/     rules/, run.ts
   src/cli.ts          capture | replay | ingest | validate
   test/
   fixtures/           payloads crudos (gitignored)
   ```
4. Scripts npm: `db:up`, `db:migrate`, `db:reset`, `test`, `capture`, `replay`, `validate`.

**Aceptación:** `npm run db:up && npm run db:migrate` funciona con cero migraciones; `npm test` pasa un smoke test que conecta a Postgres.

---

## Fase 1 — Verificación en vivo contra EODHD

Objetivo: capturar respuestas **reales** de un universo de prueba y contestar con evidencia las preguntas que el diseño dejó abiertas. Sin base de datos todavía: los payloads van a ficheros.

### 1.1 Universo de prueba

Elegido para que cada símbolo ejercite una decisión del modelo. Confirmar los códigos de bolsa con `exchanges-list` antes de usarlos.

| Símbolo | Qué prueba |
|---|---|
| `AAPL.US` | Caso base EEUU, agregado `US` → XNAS, splits, dividendos, CIK |
| `GOOGL.US` + `GOOG.US` | Doble clase: ¿mismo CIK → misma COMPANY? |
| `KO.US` | Agregado `US` → XNYS (no XNAS) |
| `META.US` | Cambio de ticker FB→META (`symbol-change-history`) |
| `JPM.US` | Banco (industria Banking; caso especial del score) |
| `O.US` | REIT (industria REITs) |
| `VTI.US` | ETF: `company_id` NULL, bloque ETF, allocation por sector |
| `SAP.XETRA` | Alemania, EUR, IFRS, ¿LEI? |
| `ITX.MC` | España (BME), EUR, IFRS |
| `SHEL.LSE` | Reino Unido, cotización en GBX (divisa fraccionaria) |
| `SHOP.TO` | Canadá, CAD |
| 1 deslistada de EEUU | Survivorship: sacar una de `exchange-symbol-list/US?delisted=1` |

### 1.2 Captura

`npm run capture` escribe cada respuesta en `fixtures/eodhd/<endpoint>/<símbolo>.json` y un `fixtures/eodhd/manifest.json` con URL **sin la key**, estado HTTP, `fetched_at` y sha256 del cuerpo. Rutas de referencia (**confirmarlas en la documentación actual de EODHD**; si alguna cambió, usar la vigente y anotarlo):

- `exchanges-list`, `exchange-symbol-list/{CODE}` (y con `delisted=1`)
- `fundamentals/{SÍMBOLO}`
- `eod/{SÍMBOLO}`, `div/{SÍMBOLO}`, `splits/{SÍMBOLO}`
- `calendar/earnings?symbols=…`, `symbol-change-history`, `insider-transactions?code=…`, `news?s=…`
- FX: `eod/EURUSD.FOREX`, `eod/EURGBP.FOREX`, `eod/EURCAD.FOREX`
- SEC EDGAR (sin key, exige cabecera `User-Agent` con contacto): `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` para Apple

Antes de nada, anotar qué endpoints cubre el plan contratado de la API key (fundamentales suele ir aparte).

Si hay un plugin/MCP de EODHD instalado, puede usarse para explorar y localizar campos más rápido, pero **cada respuesta del informe se comprueba contra el fichero capturado** por `capture` (respuesta HTTP en bruto), y se cita esa ruta. El código del normalizador no depende del plugin.

### 1.3 Preguntas a contestar

Rellenar `docs/verificacion-eodhd.md` (plantilla ya creada). Para cada pregunta: veredicto (sí / no / parcial), ruta exacta en el JSON, un valor de ejemplo e impacto en el modelo.

- **★ C1 — CIK y LEI a nivel de empresa.** ¿Dónde vienen (`General.CIK`, `General.LEI` u otro)? ¿Poblados en EEUU, Europa y Canadá? ¿GOOGL y GOOG comparten CIK? **Es la pregunta bloqueante**: decide si el agrupamiento por empresa funciona o todo cae a `isolated`.
- C2 — ISIN por símbolo: ¿presente en todo el universo?
- C3 — Fecha de presentación en fundamentales: ¿hay fecha real de publicación por periodo (algo tipo `filing_date`) o solo cierre de periodo? Decide `reported_at_source = provider` vs `estimated`.
- C4 — Divisa de los estados financieros frente a la de cotización. ¿`SHEL.LSE` cotiza en GBX y reporta en otra divisa?
- C5 — Sub-bolsa de los símbolos `US`: ¿qué campo dice NASDAQ / NYSE / NYSE ARCA y con qué etiquetas exactas? Alimenta `SOURCE_VENUE_MAP`.
- C6 — Deslistadas: ¿cuántas y con qué profundidad histórica de precios y fundamentales?
- C7 — Splits como `"N/M"` y dividendos con `unadjustedValue` + divisa: confirmar formato.
- C8 — InsiderTransactions: ¿id estable por transacción?
- C9 — Holders institucionales y fondos: ¿id estable del filer (`holder_ref`)?
- C10 — Analistas: dirección de la escala de rating (¿1 = Strong Buy?).
- C11 — Bloque ETF: NAV, holdings (¿con ISIN del constituyente?), etiquetas de sector en la allocation.
- C12 — Earnings: campos, antes/después de mercado, y si la fecha de periodo casa con la de los estados financieros.
- C13 — News: ¿etiquetada por lista de símbolos?
- C14 — `symbol-change-history`: cobertura (¿solo EEUU?) y si aparece FB→META.
- C15 — Lista literal de etiquetas de sector e industria vistas en el universo (entrada para la taxonomía, decisión abierta D3).
- C16 — Valores literales de `Type` vistos (entrada para la decisión abierta D2).
- C17 — Acciones en circulación: ¿de qué sección salen y con qué fechas?

**Entregable:** `docs/verificacion-eodhd.md` completo, commit (sin `fixtures/`). **Parar aquí y avisar a David**: este documento vuelve a la conversación de diseño. Si C1 sale negativo, puede cambiar la decisión de identidad.

---

## Fase 2 — Base de datos (fuente de verdad + normalizador + transversales)

Especificación: `docs/modelo/modelo-general.md` y cada par de chunk. Migraciones en este orden (respeta las FK):

| Migración | Tablas | Doc |
|---|---|---|
| `001_referencia` | ASSET_TYPE, EXCHANGE, SECTOR, INDUSTRY | núcleo, taxonomía |
| `002_identidad` | COMPANY, SECURITY, LISTING, LISTING_TICKER_CHANGE | núcleo, identidad |
| `003_hechos` | FUNDAMENTALS, SHARES_OUTSTANDING, PRICES_DAILY, FX_RATES, STOCK_SPLIT, DIVIDEND, EARNINGS | núcleo, earnings |
| `004_dividend_clave` | (cambio sobre DIVIDEND: clave `UNIQUE (security_id, ex_date)`) | `decisiones-modelo.md` §5.5 |
| `005_ownership` | HOLDER_POSITION, INSIDER_TRANSACTION, OWNERSHIP_SNAPSHOT, ANALYST_CONSENSUS, SHORT_INTEREST | ownership |
| `006_holder_name_norm` | (cambio sobre `holder_name_norm()`: colapsa espacios internos; `REINDEX` del índice de `holder_position`) | `decisiones-modelo-ownership.md` §2.b |
| `007_etf` | ETF_PROFILE, ETF_SNAPSHOT, ETF_HOLDING, ETF_ALLOCATION | etf |
| `008_etf_holding_clave` | (cambio sobre ETF_HOLDING: prefijos `sym:`, `isin:` y `name:` en el índice único) | `decisiones-modelo-etf.md` §2.c |
| `009_noticias` | NEWS, NEWS_SECURITY | noticias |
| `010_normalizador` | INGESTION_RUN, PAYLOAD_BLOB, RAW_PAYLOAD, SOURCE_EXCHANGE, SOURCE_VENUE_MAP, SOURCE_HOLDER_MAP, SOURCE_SECTOR_MAP | ingesta, referencia, identidad, taxonomía |
| `011_transversal` | DIMENSION_AUDIT, VALIDATION_RULE, DATA_QUALITY_FINDING | auditoría, validación |
| `012_triggers` | ver abajo | etf, taxonomía, auditoría |

Total: **36 tablas**.

### Restricciones que no se pueden olvidar

- `COMPANY`: `cik` y `lei` UNIQUE; `identity_source` CHECK (`cik`, `lei`, `isolated`); `sector_id`, `industry_id` FK nullable.
- `SECURITY`: `isin` UNIQUE; `company_id` nullable (lo gobierna el trigger T1).
- `LISTING`: `provider_symbol` UNIQUE; índice único parcial `(security_id) WHERE is_primary_listing`.
- `FUNDAMENTALS`: UNIQUE `(company_id, period_end, period_type, reported_at)`; `period_type` CHECK (`Q`, `A`); `reported_at_source` CHECK con DEFAULT `'estimated'`; `currency` NOT NULL; `cross_checked_at` nullable. `SHARES_OUTSTANDING` sigue el mismo patrón.
- `PRICES_DAILY` PK `(listing_id, date)`; `FX_RATES` PK `(currency, date)`; `DIVIDEND.currency` NOT NULL.
- `EARNINGS` PK `(security_id, fiscal_period_end, period_type)`; `report_time` CHECK.
- `ETF_ALLOCATION`: UNIQUE `(security_id, as_of_date, dimension, bucket)`; `sector_id` FK nullable; `source` CHECK.
- `RAW_PAYLOAD.provider_symbol` es TEXT **sin FK** (desacople deliberado). `content_hash` FK a `PAYLOAD_BLOB`.
- `DIMENSION_AUDIT` y `DATA_QUALITY_FINDING`: `target_table`/`row_id` **sin FK** (polimórficas a propósito).

### Triggers (`012_triggers`)

- **T1** `SECURITY` BEFORE INSERT/UPDATE: `ASSET_TYPE.requires_company = true` ⇒ `company_id` NOT NULL; `false` ⇒ NULL.
- **T2** `ASSET_TYPE` BEFORE UPDATE: `requires_company` inmutable si el tipo ya tiene securities.
- ~~**T3**~~ Eliminado: la consistencia sector/industria de `COMPANY` es una FK compuesta `(industry_id, sector_id)` → `INDUSTRY` con `MATCH SIMPLE` (migración `010_normalizador`), no un trigger. Los triggers de esta migración son T1, T2 y T4.
- **T4** Auditoría AFTER INSERT/UPDATE/DELETE en COMPANY, SECURITY, LISTING, EXCHANGE, ASSET_TYPE, ETF_PROFILE, SECTOR, INDUSTRY, VALIDATION_RULE y las cuatro `SOURCE_*`. Una fila por columna que **realmente** cambió (`IS DISTINCT FROM`); `changed_by` y `reason` de `current_setting('app.actor', true)` / `('app.reason', true)`; `change_set_id` uno por transacción (si la app no puso `app.change_set_id`, el trigger lo fija con `set_config(…, true)`).
- En la app, `withActor(actor, reason, fn)`: abre transacción, hace `SET LOCAL` de las variables y ejecuta `fn`. Toda escritura del normalizador en dimensiones pasa por aquí.

### Seeds

`ASSET_TYPE` (`common_stock`: en scope, requiere company; `etf`: en scope, no requiere), `EXCHANGE` (MICs del universo con `timezone` y `close_time`), `SOURCE_EXCHANGE` y `SOURCE_VENUE_MAP` (de lo visto en C5 y `exchanges-list`), `VALIDATION_RULE` (catálogo, ver Fase 4), `SECTOR`/`INDUSTRY` (provisional, D3).

### Aceptación (tests contra Postgres real)

- A1 Existen exactamente 36 tablas del modelo (sin contar `schema_migrations`).
- A2 Acción sin company → error. ETF con company → error.
- A3 Cambiar `requires_company` de un tipo con securities → error.
- A4 Company con industria de otro sector → error (FK compuesta, ver `010_normalizador`). Solo sector → ok. Solo industria → ok. Ambos NULL → ok.
- A5 Un UPDATE de `legal_name` y `sector_id` en la misma transacción → 2 filas de `DIMENSION_AUDIT` con el mismo `change_set_id` y `changed_by`/`reason` rellenos. Un UPDATE que no cambia nada → 0 filas.
- A6 Dos listings primarios para la misma security → error.
- A7 Restatement: misma `(company, period_end, period_type)` con distinto `reported_at` → ok; con el mismo → error.
- A8 `reported_at_source` sin valor → `estimated`; valor fuera de dominio → error.

---

## Fase 3 — Normalizador

Especificación: `decisiones-modelo-ingesta.md`, `-referencia`, `-identidad`, `-taxonomia`, `-auditoria`.

1. **Ingesta cruda.** **Al arrancar una corrida, el orquestador cierra como `failed` cualquier corrida del mismo `scope` que siga en `running`** (el proceso murió; `finished_at` queda informado). Un fallo de transporte (timeout, conexión cortada) también deja una fila en `RAW_PAYLOAD` con `transport_error`, sin `http_status` ni `content_hash`; una respuesta 4xx/5xx sí tiene cuerpo y va a `PAYLOAD_BLOB`. `capture` escribe `INGESTION_RUN` → `PAYLOAD_BLOB` (sha256 del cuerpo sin comprimir, cuerpo gzip, dedup por hash) → `RAW_PAYLOAD`. `replay` carga los ficheros de `fixtures/` en las mismas tablas, de modo que todo lo que viene después **solo lee de `RAW_PAYLOAD`**, venga de la API o de fichero. `parse_status`/`parse_error` se actualizan por payload.
2. **Referencia.** `provider_symbol` → MIC según `SOURCE_EXCHANGE` (`single` / `aggregate` + `SOURCE_VENUE_MAP` / `virtual`). Venue desconocido → sin MIC y finding `VENUE_UNMAPPED`; nunca se inventa un MIC. **El filtro por tipo (D2, `ASSET_TYPE`) va antes de resolver el venue**: los fondos de inversión de la etiqueta `NMFQS` se descartan por tipo y no generan `VENUE_UNMAPPED`.
3. **Identidad.** Implementar `resolver()` y `resolver_company()` tal como están en `modelo-entidades-identidad.md`: camino rápido por `provider_symbol`; ISIN → (MIC, ticker) → nuevo; company por CIK → LEI → `isolated` (+ finding `IDENTITY_ISOLATED`). Un identificador que contradice un enlace existente → finding `IDENTITY_RELINK_CONFLICT` y **no se re-enlaza**. Cambio de ticker: actualizar `provider_symbol` + fila en `LISTING_TICKER_CHANGE`, mismo `listing_id`.
4. **Taxonomía.** Etiquetas del proveedor → `SOURCE_SECTOR_MAP` → `sector_id`/`industry_id`. Sin mapeo → NULL + `SECTOR_UNMAPPED`. Lo mismo para la allocation por sector de los ETF.
5. **Escritores**, empezando por un corte vertical completo de `AAPL.US` y ampliando después:
   1. Precios brutos (`eod`) → `PRICES_DAILY`.
   2. Splits `"N/M"` → `split_numerator` / `split_denominator`.
   3. Dividendos: `unadjustedValue` → `amount_native`, con su divisa.
   4. Fundamentales: una fila por periodo y tipo; `reported_at` = fecha real de publicación si C3 la confirma (`provider`), si no `period_end + 45 días` (`estimated`); `currency` de los estados.
   5. Acciones en circulación, earnings.
   6. FX: `rate_to_base` = valor de 1 unidad en EUR (USD = 1/EURUSD). GBX es fila propia con GBP/100 dentro del tipo.
   7. ETF: perfil, NAV, holdings (constituyente resuelto por ISIN), allocation.
   8. Ownership, analistas, short interest, insiders, holders (`SOURCE_HOLDER_MAP`). Noticias (fuera de la fuente de verdad): upsert de `news` por `url`; `news_security` se puebla resolviendo símbolo EODHD -> `LISTING` -> `SECURITY` por el mismo crosswalk que el resto, solo **crece** (nunca se borra) y lo que no resuelve se **ignora sin finding** (`modelo-noticias.md` decisión 7).

   Cada escritor es **idempotente**: upsert por clave natural.

**Aceptación:**
- Mismo cuerpo capturado dos veces → 2 `RAW_PAYLOAD`, 1 `PAYLOAD_BLOB`.
- Corte vertical `AAPL.US`: listing en XNAS; `identity_source` coherente con C1; nº de filas de precios = filas del payload; splits y dividendos iguales a los del payload (comprobado contra el fichero, no de memoria).
- `replay` ejecutado dos veces → mismos recuentos por tabla y **0 filas nuevas** en `DIMENSION_AUDIT` en la segunda pasada.

---

## Fase 4 — Validación

Especificación: `decisiones-modelo-validacion.md`. El runner lee las reglas `enabled` de `VALIDATION_RULE` y ejecuta la lógica en código indexada por `rule_code`. No duplica findings abiertos para la misma regla y objetivo.

| rule_code | Lógica (provisional donde se indica) |
|---|---|
| `ACCOUNTING_BALANCE` | **Desactivada** hasta resolver D4. |
| `CURRENCY_COHERENCE` | Divisa de `FUNDAMENTALS` y `quote_currency` del listing tienen camino de FX en `FX_RATES`; si no, `error`. |
| `YOY_JUMP` | Ingresos o acciones con variación >200 % frente al mismo periodo del año anterior → `warning`. |
| `STALENESS` | Últimos fundamentales o último precio más viejos que el umbral → `warning`, objetivo `security`. |
| `SECOND_SOURCE_MISMATCH` | Cross-check SEC EDGAR (abajo). |
| `IDENTITY_ISOLATED`, `IDENTITY_RELINK_CONFLICT`, `HOLDER_UNMAPPED`, `SECTOR_UNMAPPED`, `VENUE_UNMAPPED`, `ASSET_TYPE_UNMAPPED` | Las emite el normalizador; aquí solo se catalogan. |

**Cross-check SEC EDGAR** (empresas de EEUU con CIK): comparar ingresos, beneficio neto y activo total del periodo equivalente. Dentro de tolerancia → `reported_at_source = 'cross_checked'` y `cross_checked_at = now()`. Fuera → finding `SECOND_SOURCE_MISMATCH`, sin tocar el enum. Respetar el límite de peticiones de la SEC.

**Aceptación:** una fila manipulada a propósito genera su finding; Apple queda `cross_checked` en al menos un periodo anual; ejecutar la validación dos veces no duplica findings abiertos.

---

## Fase 5 — Prueba de ingesta extremo a extremo

`replay` del universo completo + validación. Resultado esperado (condicionado a lo que diga la Fase 1):

- `GOOGL.US` y `GOOG.US` → la misma `company_id` si comparten CIK. Si EODHD no da CIK, ambas `isolated` con su finding: es el comportamiento correcto, no un fallo.
- `AAPL.US` → XNAS; `KO.US` → XNYS.
- `SHEL.LSE` con `quote_currency = 'GBX'` y filas GBX en `FX_RATES`.
- `VTI.US` con `company_id` NULL, perfil ETF y allocation por sector con `sector_id` donde haya mapeo.
- `META.US`: un único listing con su cambio de ticker registrado (si la historia lo cubre).
- `JPM.US` y `O.US` en las industrias Banking y REITs (si el seed de D3 las tiene).
- Segunda pasada idempotente.

**Entregable:** `docs/informe-ingesta-e2e.md` con recuentos por tabla, findings por regla, distribución de `identity_source` y cualquier desviación respecto a lo esperado.

---

## Decisiones abiertas (implementar en provisional, aislado y anotado)

Huecos detectados al planificar que el diseño no resuelve todavía. Se implementa el valor provisional en **un único sitio** y se anota en `docs/registro.md`; la decisión final se toma en la conversación de diseño.

| Id | Hueco | Provisional |
|---|---|---|
| D1 | Qué listing es el **primario** cuando una security cotiza en varias bolsas (el índice garantiza como máximo uno, no cuál). | Una security = un símbolo en v1; su único listing es primario. No se ingieren cotizaciones múltiples de la misma security todavía. |
| D2 | Cómo se mapea el `Type` de EODHD a `ASSET_TYPE` (no hay tabla `SOURCE_*` para ello). | Mapa constante en un módulo (`Common Stock` → `common_stock`, `ETF` → `etf`); tipo desconocido → no se ingiere + finding `ASSET_TYPE_UNMAPPED`. |
| D3 | Set inicial de `SECTOR` / `INDUSTRY`. | Borrador propio (~11 sectores, sin copiar nombres ni códigos GICS) con Banking, Insurance y REITs como industrias, construido a partir de C15. **Lo aprueba David.** |
| D4 | `ACCOUNTING_BALANCE` necesita pasivo total y `FUNDAMENTALS` no lo guarda (ya faltaban gasto de impuestos y reservas para ROIC y Altman). | Regla desactivada. Sin cambiar el esquema. |
| D5 | Tolerancias de validación. | Un fichero de config: cuadre 1 %, SEC 0,5 %, salto 200 %, staleness 200 días (fundamentales) / 5 días hábiles (precios). |
| D6 | Códigos de regla nuevos (`VENUE_UNMAPPED`, `ASSET_TYPE_UNMAPPED`). | Se añaden al catálogo (es extensible por diseño), categoría `structural`, severidad `warning`. |

## Fuera de alcance

VISTAS, materializador, Business Score y cualquier dato derivado. Programación periódica (cron) de la ingesta. Segundo proveedor. Front y despliegue.
