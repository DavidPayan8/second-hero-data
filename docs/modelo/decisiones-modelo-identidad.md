# Decisiones de diseño — Resolución de identidad (normalizador)

Tercera pieza del **normalizador**. Convierte los identificadores del proveedor (`AAPL.US`, ISIN, nombre) en nuestros IDs estables (`company_id`, `security_id`, `listing_id`), de forma que sobrevivan a cambios de ticker, refetches y manías del proveedor. Continúa `decisiones-modelo-ingesta.md` y `decisiones-modelo-referencia.md`.

Estado: **cerrado**.

---

## 0. El problema y la idea central

El proveedor nos da *sus* identificadores; nosotros necesitamos *nuestros* IDs estables. Si fallamos, duplicamos valores o partimos series.

**Idea central: un "libro de identidades" (crosswalk)** = la memoria del pipeline. Hace la resolución **idempotente** (un refetch encuentra lo existente, no crea duplicados) y **estable** (los IDs no cambian aunque el ticker sí). Es el patrón del anclado de `holder_ref`, generalizado.

---

## 1. Jerarquía de matching (qué identificador manda)

- **ISIN** → ancla primaria de una SECURITY: internacional, por clase de acción, no cambia con el ticker. (`SECURITY.isin`, ya en el núcleo.)
- **(MIC, ticker)** → fallback cuando no hay ISIN (EODHD lo deja nulo en algunos valores).
- **`provider_symbol` (`AAPL.US`)** → **nunca** como ancla de identidad real (el ticker cambia: FB→META). Solo como clave del crosswalk (camino rápido).

---

## 2. Crosswalk de símbolo: `LISTING.provider_symbol` (v1)

El camino rápido es un `UNIQUE` en `LISTING.provider_symbol`: "¿he visto `AAPL.US`? → es el `listing_id` 123". No hace falta tabla nueva en v1 (un proveedor). 

**El camino rápido no se salta la comprobación de identidad.** Si el registro entrante trae ISIN y no coincide con el `SECURITY.isin` del listing anclado, se aplica la regla del §6 (finding `IDENTITY_RELINK_CONFLICT`, ese símbolo no se ingiere). Motivo, visto en la verificación en vivo: EODHD **reutiliza tickers** y renombra el antiguo con sufijo (`BBBY` nuevo con ISIN `US6903701018` frente a `BBBY_old` con ISIN `US0758961009`). Sin esta comprobación, un ticker reasignado pegaría en silencio los datos de una empresa nueva a la antigua.

**Promoción futura:** un 2º proveedor llama distinto al mismo listing → se promueve a una tabla `SOURCE_LISTING_MAP (provider, provider_symbol) → listing_id`. Gancho puesto, tabla cuando llegue el requisito (mismo patrón que `issuer` del ETF y que `provider_code`/MIC).

---

## 3. Agrupamiento por empresa — Opción B

Una SECURITY nueva necesita `company_id` (NOT NULL por trigger para acciones). ¿De qué COMPANY es? El ISIN es *distinto* por clase (GOOGL ≠ GOOG), así que no agrupa.

**Decisión (B): agrupar por identificador oficial de emisor cuando exista; aislar + marcar cuando no.** Nunca por heurística de nombres.

- Buscar COMPANY por **CIK** (EEUU, por empresa) o **LEI** (global) del proveedor.
  - Existe → úsala.
  - No existe pero hay id fiable → crear COMPANY, set `cik`/`lei`, `identity_source = 'cik'|'lei'`.
  - **Sin id fiable** → crear COMPANY por security, `identity_source = 'isolated'`, marcada para revisión/fusión manual posterior.
- **`COMPANY.identity_source`** (`cik`|`lei`|`isolated`, `TEXT + CHECK`): registra **con qué evidencia** se agrupó. Mismo patrón que `reported_at_source`: no se agrupa sin dejar rastro de la evidencia.

**Por qué B:** el coste de fusionar mal dos empresas distintas (heurística de nombres, Opción C) es catastrófico y casi inauditable. Aislar por defecto (Opción A pura) rompería la doble clase desde el día uno y obligaría a migraciones. B equilibra: id oficial robusto cuando lo hay; política conservadora ("mejor aislado y marcado que mal agrupado") cuando no. No inventar datos.

---

## 4. Anclado de holder: `SOURCE_HOLDER_MAP`

Cierra el anclado de `holder_ref` que quedó abierto en el chunk de ownership. `holder_ref` puede ser intermitente (el proveedor lo da a veces); una vez visto para un holder, se fija.

- **`SOURCE_HOLDER_MAP (provider, holder_name_norm) → holder_ref`**, con `first_seen_at`. Es la memoria name→ref. La ingesta la consulta y actualiza; una vez hay ref para un nombre, no vuelve a `holder_name` aunque el proveedor lo omita.
- `holder_name_norm` = nombre normalizado (trim, mayúsculas, sin puntuación) para absorber variantes de forma ("BlackRock Inc" vs "BlackRock, Inc."). Se implementa como **función SQL `IMMUTABLE` `holder_name_norm(text)`**, la misma que usa la clave de `HOLDER_POSITION` (`decisiones-modelo-ownership.md` §2.b): una sola definición de la normalización.

---

## 5. Cambio de ticker

El endpoint `symbol-change-history` de EODHD avisa de FB→META. Al detectarlo:
- Actualizar `LISTING.provider_symbol` (FB.US → META.US).
- Poblar `LISTING_TICKER_CHANGE` (histórico).
- **Conservar el mismo `listing_id`** — no se crea uno nuevo. La identidad persiste, solo cambia la etiqueta.

---

## 6. Regla de seguridad crítica: no re-enlazar en silencio

Si un refetch trae un identificador (ISIN/CIK/LEI) que **contradice** un enlace ya existente (el proveedor "cambió de opinión" sobre a qué security/company pertenece un símbolo), **NO se re-enlaza automáticamente → se marca para revisión.** 

Reasignar en silencio un `security_id` o un `company_id` por un dato nuevo del proveedor es la vía directa a la ruptura catastrófica de identidad (y a series partidas sin rastro). La identidad, una vez anclada, solo se cambia con revisión. Mismo espíritu que el anclado de `holder_ref` y que "no inventar datos".

**Aplica también al camino rápido** (§2): un `provider_symbol` ya anclado no exime de comparar el ISIN entrante.

**Tickers reutilizados (verificación en vivo, propuesta P1):** quedan resueltos por este diseño sin cambios de esquema. `BBBY_old` (NASDAQ) y `BBBYQ` (PINK) comparten ISIN → **una SECURITY con dos LISTINGs**; el `BBBY` nuevo (NYSE, otro ISIN) → **otra SECURITY**. El símbolo es atributo del listing, nunca la identidad.

---

## 7. Instancias que reusan el patrón (ya resueltas en sus chunks)

- **Constituyente de ETF:** ISIN→`security_id` (query a `SECURITY.isin`); fallback `constituent_isin`/`name`. Anclado estable igual. (Chunk ETF.)
- **Noticias:** ticker→security (query); si el proveedor etiqueta por ticker crudo, resolver antes de insertar en `NEWS_SECURITY`. (Chunk noticias.)
- **Holder:** `SOURCE_HOLDER_MAP` (§4).

Todas son el mismo mecanismo: identificador del proveedor → ID estable nuestro, con crosswalk y anclado.

---

## 8. Restricciones de columnas de las tablas de identidad

Decidido al implementar la migración `002_identidad` (2026-10-10, propuesta P4). Criterio general, el mismo que para `EXCHANGE` (`decisiones-modelo-referencia.md` §5):

- **Dato curado por nosotros** → `NOT NULL`.
- **Dato del proveedor** → `NULL` si falta (ausencia honesta), **salvo** que sin él la fila sea peligrosa: entonces la fila no se crea (`NOT NULL`) y se emite un finding.

| Columna | Restricción | Por qué |
|---|---|---|
| `LISTING.status` | `NOT NULL`, `CHECK (status IN ('active','delisted'))` | Siempre se sabe de qué lista viene el símbolo (activos o `delisted=1`). Un estado nuevo amplía el CHECK cuando aparezca con evidencia. |
| `LISTING.status_date` | nullable | No hay constancia de que EODHD dé la fecha de baja; NULL = desconocida. |
| `LISTING.exchange_id` | nullable | NULL = bolsa no resuelta (venue desconocido en un agregado, p. ej. los símbolos `US` sin sub-bolsa) + finding `VENUE_UNMAPPED`. Mismo patrón que `COMPANY.sector_id` NULL: el listing se conserva, queda fuera de VISTAS hasta resolverse, y la resolución posterior queda auditada en `DIMENSION_AUDIT`. Resuelve la propuesta P3 por su opción (a). |
| `LISTING.quote_currency` | `NOT NULL` | Una serie de precios sin unidad es peligrosa (trampa GBX/GBP). Si el proveedor no da la divisa, el listing no se crea y se emite un finding. Nunca se rellena desde `EXCHANGE.default_currency`. |
| `SECURITY.isin` | nullable + `UNIQUE` | §1: el ISIN puede faltar (≈30 % de la lista `US`); varios NULL son legales. |
| `COMPANY.legal_name` | nullable | Dato del proveedor. El nombre del símbolo (`Alphabet Inc Class A`) **no** es el nombre legal del emisor; nunca se rellena con él ni con el ticker. Se informa cuando llegue de un campo a nivel de empresa (fundamentales). |
| `COMPANY.identity_source` | `CHECK`: `cik` ⇒ `cik` NOT NULL; `lei` ⇒ `lei` NOT NULL; `isolated` ⇒ `cik` y `lei` NULL | "No se agrupa sin dejar rastro de la evidencia" (§3). Si a una company aislada se le añade un identificador, el CHECK obliga a actualizar `identity_source` (y a revisar posibles fusiones). |

---

## Cambios al núcleo

- `COMPANY` gana **`identity_source`** (`cik`|`lei`|`isolated`).
- `LISTING.provider_symbol` gana **índice `UNIQUE`** (crosswalk v1).

---

## Pendiente / verificar en vivo

- **Qué da EODHD a nivel de empresa:** confirmar CIK (sección fundamentals, `General.CIK`) y LEI; sin eso, todo cae a `isolated`. Bloqueante para la calidad del agrupamiento.
- Forma de `symbol-change-history` (campos, cobertura fuera de EEUU — la doc dice "US only"; para Europa el cambio de ticker puede no venir → detectar por otra vía o aceptar hueco).
- Cobertura de ISIN en los símbolos de EODHD (cuántos caen al fallback (MIC,ticker)).
