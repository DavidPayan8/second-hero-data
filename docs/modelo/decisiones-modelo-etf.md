# Decisiones de diseño — ETFs

Continúa la fuente de verdad (`decisiones-modelo.md` núcleo + `decisiones-modelo-ownership.md`). Cubre el alcance "Acciones + ETFs desde v1".

Estado: **cerrado** (identidad + tablas de datos).

---

## 1. Identidad del ETF: `company_id` nullable gobernado por invariante (Opción B)

Un ETF encaja en media parte del modelo y no en la otra:
- **Encaja** en SECURITY (ISIN, ticker), LISTING (cotiza en bolsas/divisas), PRICES_DAILY, STOCK_SPLIT y DIVIDEND (los ETF hacen splits ocasionales y reparten distribuciones). Todo eso cuelga de SECURITY y **sirve sin tocar nada**.
- **No encaja** en la rama COMPANY→FUNDAMENTALS: un ETF no tiene estados financieros ni empresa operativa. Tiene una **gestora** (iShares, Vanguard), que no es una COMPANY.

**Decisión (B):** un ETF es una `SECURITY` con **`company_id NULL`** y tipo de activo ETF; sus datos propios cuelgan de SECURITY en tablas nuevas. El NULL no queda libre, se gobierna por invariante:

- **Invariante:** `requires_company = true ⇒ company_id NOT NULL` ; `requires_company = false ⇒ company_id NULL`.
- **Mecanismo (NO es un CHECK):** `asset_type` vive en la tabla `ASSET_TYPE` (SECURITY lo referencia por `asset_type_id` FK), y un CHECK de Postgres solo ve columnas de su propia fila — no puede hacer el JOIN. El invariante es **cross-tabla**, así que se declara con:
  - **`ASSET_TYPE.requires_company BOOLEAN`** — el comportamiento como **dato**, no como código (mismo patrón que `in_screener_scope`): un tipo de activo futuro declara por sí mismo si exige company, sin tocar constraints.
  - **TRIGGER en SECURITY** (BEFORE INSERT/UPDATE) que hace el JOIN a `ASSET_TYPE` y verifica el invariante contra `requires_company`.
  - **TRIGGER defensivo en ASSET_TYPE:** el trigger de SECURITY no protege contra un UPDATE de `requires_company` que invalide filas ya existentes. `requires_company` se trata como **inmutable una vez el tipo tiene securities asociadas**; un trigger simple en ASSET_TYPE impide el cambio si hay filas colgando.
- `COMPANY` **conserva su significado limpio** ("empresa operativa", siempre con posibilidad de fundamentales). No se contamina con filas huecas.

> **Cambio al núcleo:** este invariante añadió `ASSET_TYPE.requires_company` a la entidad `ASSET_TYPE` del núcleo — ya reflejado en `modelo-entidades.md`.

**Opciones descartadas:**
- **A (COMPANY hueca):** ETF con fila en COMPANY y fundamentales NULL. Reabre el pecado de aplanamiento que todo el modelo evita (mete dos naturalezas en la misma caja). Descartada.
- **C (rama emisor ISSUER/FUND):** la más fiel al dominio, pero exige una jerarquía de emisor **hoy, sin ningún requisito de v1 que la ejercite** (la gestora es dato de display, no eje de consulta). Especulación estructural. Descartada **para v1**.

**C es la evolución natural, y B es su gancho.** B es un **subconjunto** de C: el día que exista un requisito real de emisor (screener de ETFs por gestora, comparar familias de fondos), promover el campo `issuer` (ver tablas de datos) a una entidad `ISSUER` es una migración **aditiva** —nada de lo construido se tira—. Al revés (elegir C y no usarla nunca) no tiene des-migración barata. Mismo patrón que `ASSET_TYPE.in_screener_scope` y `provider_symbol`/MIC: identidad estable ahora, jerarquía después, cuando el requisito la pague.

### Corolarios
- **El materializador ramifica por tipo igualmente.** Un ETF no tiene EPS → no pasa por el cálculo de P/E; calcula expense ratio, prima/descuento sobre NAV, etc. Esa bifurcación acción-vs-ETF es inevitable en las tres opciones, así que meter el ETF en COMPANY no "unificaría" nada, solo ensuciaría la dimensión.
- **Eventos ya cubiertos:** splits y distribuciones del ETF entran por STOCK_SPLIT/DIVIDEND (cuelgan de SECURITY) sin tocar nada.
- **Flag para las tablas de datos:** `SHARES_OUTSTANDING` es bitemporal (`reported_at`), pero las acciones de un ETF cambian por creation/redemption, no por resultados que se restaten. Para ETF ese eje bitemporal es ruido → resuelto como snapshot-temporal en `ETF_SNAPSHOT` (ver §2.b).

---

## 2. Tablas de datos del ETF

Cuatro tablas nuevas, todas colgando de SECURITY. Ninguna toca el núcleo salvo el invariante de `company_id` (§1, trigger — no CHECK). Cada una clasificada por patrón temporal (marco general, ver `decisiones-modelo-ownership.md` §1).

### 2.a `ETF_PROFILE` — dimensión (casi estática), 1:1 con SECURITY

- Campos: `issuer` (gestora, **texto en v1 = gancho a Opción C**), `inception_date`, `index_tracked`, `category`/`asset_class`, `domicile`, `expense_ratio`.
- Patrón: **dimensión mutable**. Su historial lo cubre el **log de correcciones** (pendiente global, ver `README.md`), no una serie propia.
- **`expense_ratio`:** se queda en el perfil (dimensión); su historial vive en el log de correcciones (`ETF_PROFILE` está en la lista de tablas auditadas). Candidato a serie temporal propia en el futuro si aparece requisito.
- **Unidad y fuente (P7, 2026-10-10):** `expense_ratio` se guarda **en fracción** (0.0003 = 0,03 %), que es como viene el `NetExpenseRatio` del proveedor; `Yield` no es un expense ratio y no se usa. `CHECK (expense_ratio >= 0 AND expense_ratio < 0.1)` como guarda de unidades: un valor en porcentaje (0.20 queriendo decir 0,20 %) cae fuera y falla en vez de entrar como un 20 %. Un `0` se guarda tal cual: existen ETFs con comisión cero y no se puede distinguir de "no informado" sin inventar.
- **`category`** nullable (la doc lo muestra vacío) y **`domicile`** como texto del proveedor (viene el nombre del país, no un código ISO); no se traduce a ISO en v1.

### 2.b `ETF_SNAPSHOT` — cifras del fondo observadas (antes `ETF_NAV_DAILY`)

**Cambio (P7, 2026-10-10).** La primera versión era una serie diaria de NAV. Según la documentación de EODHD, **para ETFs no hay NAV diario**: solo `TotalAssets`, un valor puntual **sin fecha** (los historiales de NAV aparecen solo para fondos de inversión, fuera de alcance). Una tabla llamada "NAV diario" sin fuente de NAV diario sería engañosa, así que se renombra y se rehace con el mismo patrón que `SHORT_INTEREST`:

- Campos: `as_of_date` (día en que lo **observamos**), `aum` (`TotalAssets`, nullable), `nav` (nullable, por si un proveedor futuro lo da), `currency` (obligatoria si hay `aum` o `nav`: `CHECK`), `shares_outstanding_etf` (nullable).
- PK natural `(security_id, as_of_date)`. **Deduplicación por valor**: no se inserta una fila igual a la última de ese ETF.
- **Divisa de `aum` (P15, 2026-10-13):** `TotalAssets` no trae divisa. Para ETF **cotizados en bolsas de EEUU** se toma `General.CurrencyCode` (fondos de EEUU en USD; VTI: USD). Para el resto, **`aum` y `currency` quedan NULL** hasta verificarlo con el payload de un ETF europeo: una línea de Londres en GBX de un fondo en USD guardaría el patrimonio con la unidad equivocada (×100 y otra divisa), y eso es peor que no tenerlo. Decisión provisional, en un único sitio del código.
- **Consecuencia de producto:** sin NAV no hay **prima/descuento sobre NAV**. Esa métrica queda fuera de v1 mientras el proveedor no dé NAV para ETFs.
- Las acciones del ETF (creation/redemption) siguen aquí y **no** en `SHARES_OUTSTANDING` bitemporal (no se restatean).

### 2.c `ETF_HOLDING` — snapshot-temporal (identidad del constituyente: columnas ahora, resolución después)

- Campos: `as_of_date`, `constituent_security_id` (FK a SECURITY, **nullable**), `constituent_isin`, `constituent_name` (fallback), `weight_pct` (**NOT NULL**, define el holding), `market_value` (nullable), `shares_held` (nullable) — `market_value` y `shares_held` son datos adicionales del proveedor, **no redundantes entre sí**.
- Patrón: **snapshot-temporal** (`as_of_date` en clave, histórico conservado — la rotación de holdings es señal). `id` sintético + `UNIQUE (security_id, constituent_key, as_of_date)` (clave natural con string libre → misma regla que `HOLDER_POSITION`).
- **Constituyente = una SECURITY que a menudo ya tienes.** Por eso `constituent_security_id` FK cuando está en tu universo, con `constituent_isin`/`name` de fallback (bonos, activos fuera de cobertura). Regalo: "qué ETFs contienen esta acción" se vuelve una query.
- **Separación columna/resolución (decidido):** las **columnas se fijan ahora**; la **lógica de resolución** ISIN→`security_id` (con anclado estable, herencia de la regla de `holder_ref`) se **difiere al normalizador**. Mismo patrón que el `.US`: la columna existe, el lookup se difiere. → pendiente.
- **Actualización (P7, 2026-10-10):** según la documentación, los holdings **no traen ISIN**: vienen indexados por el símbolo del proveedor (`AAPL.US`) y sin importe, acciones ni fecha de la posición. Cambios:
  - Nueva columna **`constituent_symbol`** (texto del proveedor). Se resuelve a `constituent_security_id` por el crosswalk de `LISTING.provider_symbol`, el mismo camino rápido que el resto del normalizador.
  - **La clave única usa solo identificadores que da el proveedor, nunca nuestra resolución**: `UNIQUE (security_id, as_of_date, COALESCE('sym:' || constituent_symbol, 'isin:' || constituent_isin, 'name:' || constituent_name))`. Si la clave dependiera de `constituent_security_id`, una resolución que cambia entre ejecuciones duplicaría la fila. **Los prefijos son necesarios** (corrección del 2026-10-12): sin ellos, un constituyente identificado solo por el nombre `X` chocaría con otro identificado por el símbolo `X`, que son cosas distintas. CHECK `etf_holding_has_constituent`: al menos uno de los tres.
  - `as_of_date` = día de observación; deduplicación del **conjunto** de holdings: si es idéntico al último guardado de ese ETF, no se inserta.

### 2.d `ETF_ALLOCATION` — snapshot-temporal (proveedor canónico, derivación como validación)

- Campos: `as_of_date`, `dimension`, `bucket` (p. ej. "Technology"), `weight_pct`, `source` (`provider`|`derived`).
- **Dominio de `dimension` (P7, 2026-10-10):** `sector` | `region` | `market_cap` | `asset_class`. Es vocabulario nuestro (CHECK); los `bucket` son del proveedor (sin CHECK). Sustituye a la primera versión (`sector`/`country`/`asset_type`):
  - **`country` desaparece:** el proveedor mezcla países y regiones en el mismo bloque. Se guarda tal cual como `region`; separar países sería interpretar.
  - **`asset_type` pasa a `asset_class`** (acciones, bonos, liquidez) para no confundirlo con `ASSET_TYPE` del núcleo, que es otra cosa.
  - **`market_cap`** es nueva: el proveedor la da y no se puede reconstruir sin los holdings completos.
- **Un único peso:** para clases de activo el proveedor da tres (`Long_%`, `Short_%`, `Net_Assets_%`); se guarda el **neto** como `weight_pct`. Largo y corto solo importan para ETFs apalancados o inversos y no entran en v1; siguen en el payload crudo y se pueden reprocesar si hacen falta. Las etiquetas de sector son de estilo Morningstar y pasan por `SOURCE_SECTOR_MAP` como cualquier otra.
- Patrón: snapshot-temporal. `id` sintético + `UNIQUE (security_id, as_of_date, dimension, bucket)` (bucket es string libre).
- **Decisión (evita `weight_pct` con dos significados):**
  - **Se guarda SIEMPRE la allocation del proveedor como hecho canónico** ("primitivo dentro de nuestro límite", como el analyst consensus). Es lo que se sirve al usuario: una sola definición, consistente entre todos los ETFs. `source = 'provider'`.
  - **La derivación propia** (sumar `ETF_HOLDING` × sector del constituyente) **NO sustituye** al dato servido: se usa como **regla de validación** (cross-check — si tu suma se aleja mucho de la del proveedor, hay un dato malo). Alimenta la capa de validación pendiente.
  - **Si el proveedor NO da allocation** para un ETF, se deriva como único recurso y se marca **`source = 'derived'`** (procedencia explícita, lección de `reported_at_source`). Nunca se mezcla dato de proveedor y derivado sin rastro.
- **La derivación como cross-check requiere umbral de cobertura de holdings** (no fiarse si falta demasiado del ETF) → detalle de la capa de validación.
- **Vocabulario sectorial unificado (decidido):** cuando `dimension='sector'`, el `bucket` del proveedor se **mapea al `SECTOR` canónico** vía `SOURCE_SECTOR_MAP` (la misma tabla que clasifica empresas), guardando `ETF_ALLOCATION.sector_id`. Sin esto habría dos vocabularios de sector incompatibles (el canónico de acciones y el texto de ETF), y un filtro por "Technology" devolvería resultados incoherentes entre acciones y ETFs. `bucket` se conserva como texto crudo del proveedor (display/fallback); `sector_id` es el enlace canónico. Bucket sin mapeo → `sector_id` NULL + finding `SECTOR_UNMAPPED`. El resto de dimensiones no se mapean (`sector_id` NULL; CHECK `etf_allocation_sector_only_for_sector`).

---

## 3. Derivados de este chunk (NO en la fuente de verdad)

- **Performance del ETF** (1d/1m/1y…) → de la serie de precios.
- ~~**`premium_discount`**~~ → **no disponible en v1**: el proveedor no da NAV para ETFs (§2.b).
- **`change` de un holding** → comparar filas consecutivas de ETF_HOLDING (por `constituent_security_id`, fallback `constituent_isin`/`name`).
- **Allocation derivada** → NO se sirve (es validación); solo se materializa como dato servido cuando `source = 'derived'` (proveedor no la dio).

---

## 4. Pendiente de este chunk

- **Resolución de identidad del constituyente** (`ETF_HOLDING`): lógica ISIN→`security_id` con anclado estable, al normalizador. Verificar shape del endpoint de holdings de EODHD en vivo.
- **`expense_ratio`**: promover a serie temporal si aparece requisito.
- **Umbral de cobertura** para validar allocation derivada vs. proveedor → capa de validación.
- **Verificar en vivo** el bloque `ETF_Data` de EODHD (holdings, allocations, `TotalAssets` y su divisa) — todo lo de P7 sale de documentación, no de payloads.
- **Coste:** cada respuesta de fundamentales de un ETF cuesta 10 llamadas y pasa de 100 KB. Como los datos cambian poco y hay deduplicación por valor, la cadencia de refresco de ETFs será semanal o mensual, no diaria (se decide en la Fase 3).

---

## 5. Contraste con la documentación de EODHD (propuesta P7)

| | Discrepancia | Decisión |
|---|---|---|
| a | No hay NAV diario de ETFs, solo `TotalAssets` sin fecha | `ETF_NAV_DAILY` pasa a `ETF_SNAPSHOT` por día de observación; sin prima/descuento en v1 (§2.b). |
| b | Holdings por símbolo, sin ISIN, importe ni fecha | Columna `constituent_symbol`; clave solo con identificadores del proveedor (§2.c). |
| c | Allocation por región mezclada, capitalización y tres pesos | Dimensiones `sector`/`region`/`market_cap`/`asset_class`; solo el peso neto (§2.d). |
| d | Tres candidatos a expense ratio, unidades distintas | `NetExpenseRatio` en fracción, CHECK de unidades, el 0 se guarda (§2.a). |
| e | `Category` vacío, `Domicile` como nombre | Ambos texto del proveedor, nullable (§2.a). |
| f | 10 llamadas y >100 KB por respuesta | Refresco semanal o mensual (§4). |
