# Decisiones de diseño — Datos de referencia (código-proveedor ↔ MIC)

Segunda pieza del **normalizador**. Habilita la resolución `provider_symbol` → bolsa real (MIC) → `exchange_id`. Continúa `decisiones-modelo-ingesta.md`.

Estado: **cerrado**.

---

## 0. El problema

El código de exchange de EODHD **no es una bolsa**. `US` es un agregado de NYSE + NASDAQ + OTC (MICs XNAS, XNYS, OTCM). El sufijo del símbolo (`AAPL.US`) es el código del proveedor, no un MIC. El MIC operativo real de un valor se resuelve **a nivel de símbolo**. Hay que desmezclar tres conceptos:
- **Bolsa real** → `EXCHANGE` (por MIC). Ya existe en el núcleo.
- **Cómo la llama el proveedor** → código `US`, `LSE`, `XETRA`…
- **Sub-bolsa dentro de un agregado** → NASDAQ dentro de `US` es XNAS.

---

## 1. Dónde viven estas tablas: capa del normalizador, no el núcleo

`SOURCE_EXCHANGE` y `SOURCE_VENUE_MAP` son sobre **"cómo nombra EODHD las cosas"**, no sobre el mundo real. Pertenecen a la capa del normalizador/ingesta. `EXCHANGE` (el mundo real, por MIC) queda limpio. Un segundo proveedor = filas con `provider='otro'`; por eso el `provider` va en la PK de ambas.

---

## 2. Dos tablas, no una (decisión)

- **`SOURCE_EXCHANGE`** — catálogo de códigos del proveedor. El `kind` (`single`|`aggregate`|`virtual`) es propiedad del código; `default_mic` solo aplica a `single`.
- **`SOURCE_VENUE_MAP`** — la sub-bolsa dentro de un agregado: `(provider, provider_code, provider_venue_label) → mic`.

**Se descarta** una tabla única con `venue` nullable: el `kind` es del código y los venues son filas por sub-bolsa; fusionarlas obliga a columnas condicionales-por-tipo y nulos (el mismo anti-patrón que evitamos con splits/dividendos y con CORPORATE_ACTION). Separadas respetan la integridad y quedan listas para cualquier proveedor futuro.

### 2.a `SOURCE_EXCHANGE`
- PK `(provider, provider_code)`.
- `kind`: `single` (una bolsa → `default_mic`, ej. `LSE → XLON`), `aggregate` (`US` → `default_mic` NULL, se resuelve por símbolo), `virtual` (`FOREX`/`CC`/`INDX` → fuera de scope; el flag le dice al normalizador que lo salte).
- `default_mic` FK a `EXCHANGE.mic`, NULL salvo `single`.

### 2.b `SOURCE_VENUE_MAP`
- PK `(provider, provider_code, provider_venue_label)` → `mic` (FK a `EXCHANGE.mic`).
- Ej.: `(eodhd, US, 'NASDAQ') → XNAS`, `(eodhd, US, 'NYSE') → XNYS`, `(eodhd, US, 'NYSE ARCA') → ARCX`, `(eodhd, US, 'OTC') → OTCM`.
- Es dato **curado** (seed), no lo escribe el normalizador. Que solo haya filas para códigos `aggregate` se comprueba con un test sobre el seed, no con el esquema.

### 2.c Granularidad de `EXCHANGE` y mapa de las etiquetas de `US` (P9, 2026-10-12)

**Regla:** una fila de `EXCHANGE` = **una bolsa registrada**, con el MIC de segmento cuando un mismo operador tiene varias (ISO 10383): `ARCX` (NYSE Arca) y `XASE` (NYSE American) son segmentos del operador `XNYS`; `BATS` (Cboe BZX) es segmento del operador `XCBO`. Cada una es una bolsa distinta con su propio registro, así que es un venue distinto.

**Los niveles de OTC no son bolsas.** PINK, OTCQB, OTCQX, Grey, Caveat Emptor… son la clasificación que OTC Markets da a un valor dentro de un mismo mercado, y un valor cambia de nivel a menudo (QX → Pink por incumplir requisitos). ISO 10383 los tiene como segmentos de `OTCM` (`PINX`, `OTCB`, `OTCQ`, `PSGM`, `CAVE`…), pero usarlos como venue convertiría cada cambio de nivel en un falso cambio de bolsa del `LISTING`. Todos se mapean al operador **`OTCM`**.

**Que el `OperatingMIC` de `exchanges-list` para `US` sea `XNAS, XNYS, OTCM, XCBO` no contradice esto:** ese campo lista operadores; nuestro `EXCHANGE` lista bolsas. Para el agregado `US` la resolución usa **solo la etiqueta por símbolo** (§3), nunca el `OperatingMIC` del código.

| Etiqueta (`exchange-symbol-list/US` → `Exchange`) | MIC | Nota |
|---|---|---|
| `NASDAQ` | `XNAS` | |
| `NYSE` | `XNYS` | |
| `NYSE ARCA` | `ARCX` | |
| `NYSE MKT`, `AMEX` | `XASE` | mismo mercado, nombre histórico |
| `BATS` | `BATS` | Cboe BZX (segmento de `XCBO`) |
| `OTC`, `PINK`, `OTCPK`, `OTCQB`, `OTCQX`, `OTCMKTS`, `OTCGREY`, `OTCCE` | `OTCM` | niveles de OTC Markets |
| `OTCBB` | — sin fila | el OTC Bulletin Board de FINRA ya no opera; asignarle `OTCM` sería suponer. 5 símbolos → `VENUE_UNMAPPED` |
| `US` | — sin fila | sub-bolsa no resuelta (556 símbolos) → `exchange_id` NULL + `VENUE_UNMAPPED`. Contrastar con `General.Exchange` de `fundamentals` en la Fase 3 |
| `NMFQS` | — sin fila | fondos de inversión (25.484). El filtro por tipo va **antes** de resolver el venue, así que no generan `VENUE_UNMAPPED` |

- **Por qué mapear PINK aunque sea mucho ruido:** las empresas en quiebra pasan a Pink con sufijo `Q` (`BBBYQ`, `SHLDQ`). Sin ese mapa, el rastro de deslistadas, que importa para el sesgo de supervivencia, acabaría en `VENUE_UNMAPPED`. Que el screener enseñe o no OTC es un filtro de VISTAS (`mic = 'OTCM'`), derivable; no se decide en la ingesta.
- **Pérdida conocida:** el nivel de OTC (Pink/QX/QB/Grey/Caveat Emptor) no se guarda en la fuente de verdad, solo en `RAW_PAYLOAD`. Si el producto necesita filtrar por nivel (p. ej. excluir Caveat Emptor y Grey), entra por propuesta y migración nueva.
- **`EXCHANGE` añade `BATS`** (ya estaba en el seed); los MIC verificados contra ISO 10383 son `ARCX`, `XASE` (segmentos de `XNYS`), `BATS` (segmento de `XCBO`) y `OTCM` (operador).

---

## 3. Algoritmo de resolución (en el normalizador)

1. Parte `AAPL.US` → símbolo `AAPL`, código `US`.
2. Busca `SOURCE_EXCHANGE[eodhd, US]`:
   - `single` → `default_mic`.
   - `aggregate` → lee la sub-bolsa a nivel de símbolo del payload (`exchange-symbol-list` trae el venue por símbolo), cruza con `SOURCE_VENUE_MAP` → MIC.
   - `virtual` → se salta (no en scope).
3. MIC → fila de `EXCHANGE` → `exchange_id` para el `LISTING`.

**Comportamiento-como-dato:** añadir un código o un venue nuevo = una fila, sin desplegar código. Sobrevive al agregado `US` y a un segundo proveedor.

**Regla de ingesta:** si la sub-bolsa de un símbolo agregado no está en `SOURCE_VENUE_MAP`, no se inventa un MIC — se marca el símbolo para revisión (venue desconocido), igual que el principio de "no rellenar lo que no sabes".

---

## 4. Enriquecimiento de `EXCHANGE` (cambio al núcleo)

Para el disparo de materialización por cierre de mercado, `EXCHANGE` gana:
- **`timezone`** (IANA, ej. `America/New_York`).
- **`close_time`** (hora local de cierre).

Es su sitio natural: son propiedades de la bolsa real, no del proveedor. Reflejado en `modelo-entidades.md`.

**Simplificación conocida (v1):** `close_time` es el cierre nominal; medios días y festivos no se modelan. El disparo real usa "cierre + desfase" (EODHD actualiza 2–3 h tras el cierre; US dentro de ~15 min), así que un medio día no rompe la ingesta, solo la dispara algo antes de tiempo. Afinar si hace falta.

---

## 5. `EXCHANGE` es dato curado: todas sus columnas son obligatorias

Decidido al implementar la migración (2026-10-10).

**Columnas:** `mic`, `country_iso`, `default_currency`, `timezone` y `close_time` son **NOT NULL**. `country_iso` lleva `CHECK (country_iso ~ '^[A-Z]{2}$')` (ISO 3166-1 alfa-2, mismo formato que `COMPANY.country_iso`).

**Por qué NOT NULL no contradice "no inventar datos":** esa regla protege los datos *del proveedor*, hechos sobre valores que solo conocemos si EODHD los da. `EXCHANGE` es dato de referencia que **escribimos nosotros** desde estándares (ISO 10383 para MIC y país, IANA para la zona horaria, el horario oficial de la bolsa). Toda bolsa real tiene los cinco. Un NULL aquí no expresaría "no se sabe", sino una carga incompleta, y fallaría tarde y en silencio: sin `timezone`/`close_time` no se dispara la materialización al cierre de esa bolsa. Con NOT NULL falla al cargar la referencia, que es cuando hay que enterarse.

**Reglas que acompañan a la restricción:**
- **El normalizador nunca crea filas de `EXCHANGE`.** Solo se crean desde la carga curada (seed). Un símbolo de una bolsa que no tenemos produce el finding `VENUE_UNMAPPED`, no una fila a medias. Así el NOT NULL nunca bloquea la ingesta: obliga a curar la bolsa antes.
- **`default_currency` es descriptiva y nunca rellena `LISTING.quote_currency`.** La divisa de cotización viene del proveedor, símbolo a símbolo. La verificación en vivo lo confirmó: en `SHEL.LSE` el precio llega en GBX y el dividendo en GBP, y las filas de `eod` no traen divisa; la divisa "por defecto" de la bolsa no dice en qué unidad viene una serie concreta.
- **`timezone` válida:** se comprueba en un test contra `pg_timezone_names` (un CHECK no puede consultar otra tabla).

---

## Pendiente / verificar en vivo

- ~~Nombre y valores exactos del campo de sub-bolsa por símbolo~~ ✅ campo `Exchange`, 17 etiquetas; mapa en §2.c.
- ~~Seed inicial de `SOURCE_EXCHANGE`~~ ✅ desde `exchanges-list` (migración 010): solo códigos cuya bolsa está curada en `EXCHANGE`, más `US` (aggregate) y los virtuales.
- Horarios de cierre y timezones por MIC (fuente estándar, no EODHD).
