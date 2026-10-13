# Decisiones de diseño — Ownership / Analistas / Short Interest

Continúa `decisiones-modelo.md` (núcleo). Resumen de las decisiones cerradas de este chunk:

- `shares_short_prior_month`: no es fuente, es *fallback de arranque* — el dato real es la serie (fila `settlement_date` anterior).
- `UNIQUE` natural en todas las tablas append-only de este chunk; regla de PK unificada con el núcleo (natural donde la clave es limpia, `id` sintético solo con string libre en la clave).
- Identidad del holder: `holder_ref` (id estable del proveedor) como clave preferida; `holder_name` como fallback, riesgo nombrado.
- `rating_mean`: se guarda tal cual, **sin fijar dirección en la fuente de verdad** (la doc del proveedor indica 5 = Strong Buy, al revés de lo que se asumió al principio); ver §7.
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
- **Riesgo nombrado:** cuando solo hay `holder_name`, el derivado de variación es frágil ante cambios de forma del nombre. No se normaliza un `HOLDER` a entidad propia en v1 (sobre-ingeniería para el MVP), pero queda anotado como riesgo conocido y como candidato de v2 si duele. **La normalización solo absorbe variaciones de forma** (mayúsculas, puntuación, espacios); **no** equivalencias de significado como `Inc` = `Incorporated` o `Ltd` = `Limited`. Eso sería una heurística sobre nombres, el mismo tipo de regla que se rechazó para agrupar empresas (Opción B), porque una fusión falsa es peor que una serie partida. Si con datos reales las series se parten por sufijos, la solución es un mapa curado de alias, no reglas automáticas.
- **Provisional:** que EODHD dé un id estable de filer no está verificado en vivo. Confirmar antes de construir la ingesta.
- **Actualización (P6, 2026-10-10):** según la documentación de EODHD, `Holders` no trae ningún id estable, así que con este proveedor `holder_ref` será NULL y la identidad cae siempre al nombre. Por eso el `UNIQUE` usa el **nombre normalizado**, no el literal: `UNIQUE (security_id, COALESCE(holder_ref, holder_name_norm(holder_name)), as_of_date)`. `holder_name_norm()` es una función SQL `IMMUTABLE` (trim, mayúsculas, sin puntuación y espacios internos colapsados a uno) y es **la misma** que define la clave de `SOURCE_HOLDER_MAP`: una sola definición de normalización en la base de datos. `holder_name` se sigue guardando literal para mostrarlo. `SOURCE_HOLDER_MAP` queda como gancho para un proveedor futuro que sí dé ids (p. ej. el CIK del filer en los 13F de la SEC).

### 2.c `INSIDER_TRANSACTION` (hallazgo 5)

Hecho-puntual append-only **sin clave natural fiable**: un insider puede hacer dos transacciones idénticas el mismo día, así que `(security_id, insider_name, transaction_date, code, shares)` no garantiza unicidad. Sin clave de dedup, cada re-fetch del histórico duplica filas.

- **`provider_txn_id TEXT NULL`**: id de transacción/filing del proveedor si existe → **clave de dedup preferida** (`UNIQUE`).
- **Fallback de dedup** cuando no hay `provider_txn_id`: `(security_id, insider_name, transaction_date, transaction_code, shares_transacted)` como clave *tolerable* (acepta el falso duplicado raro de dos operaciones idénticas el mismo día como mal menor frente a duplicar en cada re-ingesta).
- **Provisional:** shape completo y existencia de `provider_txn_id` **sin verificar** contra doc en vivo de EODHD. Confirmar shape antes de construir la ingesta.
- **Actualización (P6, 2026-10-10):** según la documentación, el endpoint de Form 4 trae un `accession_number` **por filing** (no por transacción) y solo cubre EEUU; el feed plano no trae id y la doc dice que devuelve vacío para `AAPL.US`. **No se cambia el esquema todavía**: `provider_txn_id` nullable + clave de fallback cubren ambos casos. La fuente concreta (Form 4 o feed plano) y si `accession_number` + algo identifica una transacción se deciden con un payload real. En Europa no hay feed de insiders: cobertura NULL.

---

## 3. Ownership agregada: `OWNERSHIP_SNAPSHOT`

Snapshot-temporal. `as_of_date` = `General.UpdatedAt` de la ingesta. PK natural `(security_id, as_of_date)`. Append-only, histórico conservado.

**Menor (ruido):** si el proveedor toca `UpdatedAt` sin que el ownership real cambie, se acumulan filas idénticas consecutivas. Es ruido, no error. La ingesta puede **deduplicar por valor** (no insertar si la última fila para esa security es idéntica en todos los campos de ownership). Optimización, no requisito.

---

## 4. Analistas: `ANALYST_CONSENSUS`

Snapshot-temporal. PK natural `(security_id, as_of_date)`. Append-only, histórico conservado.

- **`target_currency` explícito** (no asumir `quote_currency`). El precio objetivo puede venir en divisa distinta a la de cotización → reconciliar en lectura, misma regla que `FUNDAMENTALS.currency`/`DIVIDEND.currency`.
- **`rating_mean` — dirección de escala:** **la fuente de verdad no fija la dirección**; guarda el valor tal cual lo da el proveedor. La primera versión asumía 1 = Strong Buy; la documentación de EODHD dice lo contrario (5 = Strong Buy, 1 = Strong Sell) y su ejemplo cuadra (`Rating: 4.1064` con 24 Strong Buy y 1 Strong Sell). Interpretar la escala es cosa de VISTAS, y antes de usarla se confirma con un payload real. Si la lectura se equivoca de dirección, invierte todo el consenso.
- **Recuentos por recomendación** (P6): el proveedor da cuántos analistas están en cada categoría. Son primitivos (no se reconstruyen desde la media), así que se guardan: `strong_buy`, `buy`, `hold`, `sell`, `strong_sell` (enteros, nullable). Además permiten **comprobar la dirección con los propios datos**: la media ponderada de los recuentos solo coincide con `rating_mean` en una de las dos orientaciones (regla de validación candidata).
- **`num_analysts`** solo se rellena si el proveedor da el número explícito; si no, es la suma de los recuentos y se deriva en VISTAS (no se guarda lo derivable). **`target_low` / `target_high`**: NULL cuando el proveedor solo da la media (`TargetPrice`).

---

## 5. Short interest: solo el hecho, no los ratios

Snapshot-temporal. PK natural **`(security_id, as_of_date)`**.

- **`SHORT_INTEREST(security_id, as_of_date, settlement_date, shares_short, shares_short_prior_month)`.** `shares_short` es la columna primitiva de la que cuelgan los derivados.
- **Cambio de clave (P6, 2026-10-10):** la primera versión usaba `settlement_date` como clave, pero según la documentación EODHD da el short interest **sin fecha de liquidación** (`Technicals.SharesShort` con valor; `SharesStats.ShortInterest` a null en el ejemplo). La clave pasa a **`as_of_date` = día en que lo observamos**, y `settlement_date` queda **nullable**, rellena solo si el proveedor la da. No se infiere la fecha de liquidación del calendario de FINRA: el dato del proveedor puede ir un ciclo por detrás y eso sería inventar. Consecuencia conocida: el valor puede tener hasta ~2 semanas de antigüedad respecto a `as_of_date`.
- **Deduplicación por valor obligatoria:** como el dato solo cambia cada ~2 semanas y se puede observar a diario, no se inserta una fila si `shares_short` es igual al de la última fila de esa security. Así cada fila de la serie es un cambio real y el "periodo anterior" es la fila previa.
- `short_ratio` (= `shares_short` ÷ volumen medio diario de `PRICES_DAILY`) y `short_percent_float` (= `shares_short` ÷ `OWNERSHIP_SNAPSHOT.shares_float`) **no se guardan**, derivables.
- Histórico conservado por `as_of_date`.

### 5.b `shares_short_prior_month` — fallback de arranque, no fuente (hallazgo 1)

En v2 se guardaba como columna primitiva, lo cual era **incoherente** con `change_p`: siendo la serie snapshot-temporal, "el short del mes anterior" es el `shares_short` de una fila anterior de la propia serie. Guardarlo es guardar un derivado.

**Decisión:** la fuente del "mes anterior" es **la serie**, no la columna. La capa de lectura deriva el periodo anterior tomando la fila previa de la serie (gracias a la deduplicación por valor, cada fila es un cambio real; no es un offset de calendario fijo).

- **`shares_short_prior_month` se mantiene como columna NULLABLE**, pero **solo como fallback de arranque**: durante la ventana en la que aún no tenemos histórico propio suficiente (primeras ingestas), no hay fila previa en la serie de la que derivar, y el valor que el proveedor entrega gratis evita un hueco. Una vez la serie tiene profundidad, la lectura **prefiere la serie** y este campo queda redundante.
- Documentado así explícitamente para no repetir la incoherencia con `change_p`: no es un dato primitivo, es un respaldo para el bootstrap.

---

## 6. Noticias: fuera de este documento

`NEWS`/`NEWS_SECURITY` viven en `modelo-noticias.md`, fuera de la fuente de verdad de rigor financiero. Definición de fuente de verdad = se valida, se deriva, se reconcilia; una noticia no cumple ninguna.

---

## Pendiente (sin cerrar en este chunk)

- Verificar shape real de `InsiderTransactions` y existencia de `provider_txn_id` contra doc EODHD en vivo (provisional). Decidir fuente: Form 4 o feed plano.
- Confirmar con payload que `Holders` no trae id estable (la doc dice que no).
- ~~Confirmar con payload la dirección de `rating_mean`~~ ✅ 5 = Strong Buy: el `Rating` de AAPL (3,7955) coincide con la media ponderada de sus recuentos en esa orientación (con 1 = Strong Buy daría 2,2045).
- Confirmar con payload que el short interest no trae fecha de liquidación.

---

## 7. Contraste con la documentación de EODHD (propuesta P6)

Al implementar la migración de ownership se contrastó el modelo con la documentación del plugin de EODHD (no con payloads: el plan Free no da fundamentales). Cinco discrepancias, resueltas así:

| | Discrepancia | Decisión |
|---|---|---|
| a | Dirección de `rating_mean` | Se guarda tal cual; la dirección no se fija en la fuente de verdad (§4). |
| b | El proveedor da recuentos por recomendación y solo la media del precio objetivo | Se guardan los cinco recuentos; `num_analysts`, `target_low`, `target_high` NULL si no vienen (§4). |
| c | Short interest sin fecha de liquidación | Clave `(security_id, as_of_date)`, `settlement_date` nullable, deduplicación por valor (§5). |
| d | Insiders: id por filing, solo EEUU | Sin cambio de esquema hasta tener payload (§2.c). |
| e | Holders sin id estable | Clave con nombre normalizado vía `holder_name_norm()` (§2.b). |

Todas las decisiones dejan el esquema válido tanto si la documentación acierta como si no: lo dudoso es nullable y lo que no se sabe no se interpreta.
- `holder_type` (institution|fund): se queda como `CHECK` inline (dos valores, no justifica tabla). Subir a tabla de referencia solo si crece.
- Capa de validación general (pendiente desde v1 del núcleo): outliers en transacciones de insiders, saltos de `shares_float` sospechosos, filas de ownership idénticas consecutivas.
