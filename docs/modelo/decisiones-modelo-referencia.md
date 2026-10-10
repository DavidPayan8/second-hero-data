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

## Pendiente / verificar en vivo

- Nombre y valores exactos del campo de sub-bolsa por símbolo en `exchange-symbol-list` de EODHD (para poblar `SOURCE_VENUE_MAP`).
- Seed inicial: lista de códigos de EODHD (`exchanges-list` da code + OperatingMIC) para poblar `SOURCE_EXCHANGE` y las filas `single`.
- Horarios de cierre y timezones por MIC (fuente estándar, no EODHD).
