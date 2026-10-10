# Decisiones de diseño — Ownership / Analistas / Short Interest

Continúa `decisiones-modelo.md` (núcleo). Resumen de las decisiones cerradas de este chunk:

- `shares_short_prior_month`: no es fuente, es *fallback de arranque* — el dato real es la serie (fila `settlement_date` anterior).
- `UNIQUE` natural en todas las tablas append-only de este chunk; regla de PK unificada con el núcleo (natural donde la clave es limpia, `id` sintético solo con string libre en la clave).
- Identidad del holder: `holder_ref` (id estable del proveedor) como clave preferida; `holder_name` como fallback, riesgo nombrado.
- `rating_mean`: dirección de escala fijada (1=Strong Buy) y marcada para verificar en vivo.
- `INSIDER_TRANSACTION`: `provider_txn_id` para dedup preferida; clave de dedup fallback definida.
- `holder_type` se queda como `CHECK` inline (dos valores, no justifica tabla de referencia).

---

## 0. Matiz al principio rector: "primitivo" es relativo al límite del sistema

Sin cambios. Un dato es primitivo para nosotros si no podemos re-derivarlo con lo que tenemos, aunque en origen ya sea un agregado (consenso de analistas, `shares_float`/`percent_insiders`/`percent_institutions`).

---

## 1. Tres patrones temporales, no dos

Sin cambios respecto a v2 en el marco. Recordatorio de la tabla:

| Patrón | Pregunta que responde | Forma | Entidades |
|---|---|---|---|
| **Bitemporal** | ¿Se restatea un hecho ya publicado? | `period_end` + `reported_at`/`reported_at_source`. Fila nueva por corrección. | `FUNDAMENTALS`, `SHARES_OUTSTANDING` |
| **Snapshot-temporal** | ¿Cambia en el tiempo sin restatearse, y la serie histórica es señal? | Un eje: `as_of_date`/`settlement_date` en la PK. Append-only, histórico conservado. | `HOLDER_POSITION`, `OWNERSHIP_SNAPSHOT`, `ANALYST_CONSENSUS`, `SHORT_INTEREST` |
| **Hecho-puntual** | ¿Ocurre una vez, con fecha propia, y no se repite para la misma clave? | Fecha propia del evento + `ingested_at` como metadata de pipeline. | `INSIDER_TRANSACTION`, `DIVIDEND`, `STOCK_SPLIT` |

**Decisión explícita (sin cambios):** se conserva histórico completo en las snapshot-temporal porque la evolución de ownership/short-interest/consenso **es señal** y no se puede reconstruir hacia atrás si solo se guarda el último valor.

---

## 1.b Regla de clave primaria para las tablas de este chunk

Para no dejar la asimetría de v2 (una tabla con PK natural, tres con `id` sintético sin UNIQUE) sin criterio:

- **PK natural** cuando la clave es limpia — `(security_id, <fecha>)` sin strings libres: `OWNERSHIP_SNAPSHOT` `(security_id, as_of_date)`, `ANALYST_CONSENSUS` `(security_id, as_of_date)`, `SHORT_INTEREST` `(security_id, settlement_date)`.
- **`id` sintético + `UNIQUE` natural** solo cuando la clave natural incluye un **string libre** que no es buena PK: `HOLDER_POSITION` (`id` PK, `UNIQUE (security_id, holder_ref_or_name, as_of_date)`).
- **`INSIDER_TRANSACTION`**: `id` sintético + clave de dedup (§5), porque no tiene clave natural fiable.

**Por qué importa:** todas estas tablas son append-only. Sin el `UNIQUE`, una re-ingesta de la misma fecha inserta filas gemelas y nadie lo impide (mismo agujero que cazamos con `is_primary_listing` y la PK de `FUNDAMENTALS`). El `UNIQUE` es lo que hace la re-ingesta idempotente.

---

## 2. Ownership: `HOLDER_POSITION` e `INSIDER_TRANSACTION`

`HOLDER_POSITION` → snapshot-temporal; `INSIDER_TRANSACTION` → hecho-puntual.

- `portfolio_weight_pct`: se guarda, no derivable por nosotros (no conocemos el portfolio completo del holder).
- `change_p` del proveedor: no se guarda, se deriva comparando dos filas consecutivas de la serie.

### 2.b Identidad del holder (hallazgo 3)

El derivado "variación de posición de un holder" compara filas consecutivas por holder. Eso exige un identificador **estable** entre snapshots, y `holder_name` no lo es: "BlackRock Inc", "BlackRock, Inc.", "Blackrock Inc." son el mismo holder con tres strings. Si el nombre varía entre dos snapshots, la serie se parte y la variación sale mal en silencio. Es el mismo problema de identidad de COMPANY/SECURITY/LISTING, un nivel más abajo.

- **`holder_ref TEXT NULL`**: identificador estable del proveedor si lo hay (p. ej. CIK del filer institucional). **Clave preferida** para el `UNIQUE` y para el derivado de variación.
- **`holder_name`**: se conserva para display; es el **fallback** de identidad cuando `holder_ref` es NULL.
- **Riesgo nombrado:** cuando solo hay `holder_name`, el derivado de variación es frágil ante cambios de forma del nombre. No se normaliza un `HOLDER` a entidad propia en v1 (sobre-ingeniería para el MVP), pero queda anotado como riesgo conocido y como candidato de v2 si duele.
- **Provisional:** que EODHD dé un id estable de filer no está verificado en vivo. Confirmar antes de construir la ingesta.

### 2.c `INSIDER_TRANSACTION` (hallazgo 5)

Hecho-puntual append-only **sin clave natural fiable**: un insider puede hacer dos transacciones idénticas el mismo día, así que `(security_id, insider_name, transaction_date, code, shares)` no garantiza unicidad. Sin clave de dedup, cada re-fetch del histórico duplica filas.

- **`provider_txn_id TEXT NULL`**: id de transacción/filing del proveedor si existe → **clave de dedup preferida** (`UNIQUE`).
- **Fallback de dedup** cuando no hay `provider_txn_id`: `(security_id, insider_name, transaction_date, transaction_code, shares_transacted)` como clave *tolerable* (acepta el falso duplicado raro de dos operaciones idénticas el mismo día como mal menor frente a duplicar en cada re-ingesta).
- **Provisional:** shape completo y existencia de `provider_txn_id` **sin verificar** contra doc en vivo de EODHD. Confirmar shape antes de construir la ingesta.

---

## 3. Ownership agregada: `OWNERSHIP_SNAPSHOT`

Snapshot-temporal. `as_of_date` = `General.UpdatedAt` de la ingesta. PK natural `(security_id, as_of_date)`. Append-only, histórico conservado.

**Menor (ruido):** si el proveedor toca `UpdatedAt` sin que el ownership real cambie, se acumulan filas idénticas consecutivas. Es ruido, no error. La ingesta puede **deduplicar por valor** (no insertar si la última fila para esa security es idéntica en todos los campos de ownership). Optimización, no requisito.

---

## 4. Analistas: `ANALYST_CONSENSUS`

Snapshot-temporal. PK natural `(security_id, as_of_date)`. Append-only, histórico conservado.

- **`target_currency` explícito** (no asumir `quote_currency`). El precio objetivo puede venir en divisa distinta a la de cotización → reconciliar en lectura, misma regla que `FUNDAMENTALS.currency`/`DIVIDEND.currency`.
- **`rating_mean` — dirección de escala (hallazgo 4):** escala 1–5 con dirección **1 = Strong Buy … 5 = Strong Sell** (convención EODHD). Es un agregado no descomponible. La dirección **debe** quedar documentada: si la capa de lectura asume "mayor es mejor", invierte todo el consenso y pinta un Strong Buy como lo peor. **Verificar la dirección contra la doc en vivo** al conectar; no darla por supuesta.

---

## 5. Short interest: solo el hecho, no los ratios

Snapshot-temporal. PK natural `(security_id, settlement_date)`.

- **`SHORT_INTEREST(security_id, settlement_date, shares_short, shares_short_prior_month)`.** `shares_short` es la columna primitiva de la que cuelgan los derivados.
- `short_ratio` (= `shares_short` ÷ volumen medio diario de `PRICES_DAILY`) y `short_percent_float` (= `shares_short` ÷ `OWNERSHIP_SNAPSHOT.shares_float`) **no se guardan**, derivables.
- Histórico conservado por `settlement_date`.

### 5.b `shares_short_prior_month` — fallback de arranque, no fuente (hallazgo 1)

En v2 se guardaba como columna primitiva, lo cual era **incoherente** con `change_p`: siendo la serie snapshot-temporal, "el short del mes anterior" es el `shares_short` de una fila anterior de la propia serie. Guardarlo es guardar un derivado.

**Decisión:** la fuente del "mes anterior" es **la serie**, no la columna. La capa de lectura deriva el prior-month buscando la fila con `settlement_date` inmediatamente anterior (ojo: el short interest se reporta en fechas de settlement ~bimensuales, así que "mes anterior" es la fila previa de la serie, no un offset de calendario fijo).

- **`shares_short_prior_month` se mantiene como columna NULLABLE**, pero **solo como fallback de arranque**: durante la ventana en la que aún no tenemos histórico propio suficiente (primeras ingestas), no hay fila previa en la serie de la que derivar, y el valor que el proveedor entrega gratis evita un hueco. Una vez la serie tiene profundidad, la lectura **prefiere la serie** y este campo queda redundante.
- Documentado así explícitamente para no repetir la incoherencia con `change_p`: no es un dato primitivo, es un respaldo para el bootstrap.

---

## 6. Noticias: fuera de este documento

`NEWS`/`NEWS_SECURITY` viven en `modelo-noticias.md`, fuera de la fuente de verdad de rigor financiero. Definición de fuente de verdad = se valida, se deriva, se reconcilia; una noticia no cumple ninguna.

---

## Pendiente (sin cerrar en este chunk)

- Verificar shape real de `InsiderTransactions` y existencia de `provider_txn_id` contra doc EODHD en vivo (provisional).
- Verificar existencia de id estable de filer (`holder_ref`) en el ownership de EODHD (provisional).
- Verificar dirección de la escala `rating_mean` en vivo.
- `holder_type` (institution|fund): se queda como `CHECK` inline (dos valores, no justifica tabla). Subir a tabla de referencia solo si crece.
- Capa de validación general (pendiente desde v1 del núcleo): outliers en transacciones de insiders, saltos de `shares_float` sospechosos, filas de ownership idénticas consecutivas.
