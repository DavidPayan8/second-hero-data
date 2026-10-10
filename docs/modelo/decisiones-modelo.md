# Decisiones de diseño — Stock Screener (fuente de verdad, núcleo)

Documento de decisiones cerradas sobre el modelo de datos. Recoge el **qué** y el **porqué** de cada decisión, para no reabrirlas y para poder justificarlas más adelante.

Ver también: `decisiones-modelo-ownership.md` (analistas/ownership/short interest), `decisiones-modelo-etf.md` (ETFs), `modelo-noticias.md` (noticias, subsistema aparte). Índice general en `README.md`.

Última actualización: 2026-10-01

---

## Principio rector

> **No se almacena lo que se puede derivar sin ambigüedad.**

La fuente de verdad guarda únicamente el dato primario que entrega el proveedor, en su forma nativa e inmutable. Todo lo que es un cruce entre niveles o una función de otros datos (EPS, P/E, capitalización, precio ajustado) se **deriva** y se materializa en la capa de lectura, nunca en la fuente de verdad.

Corolario: la fuente de verdad no sabe que la capa de lectura existe. El snapshot es reconstruible al 100% desde la fuente; si algún dato solo vive en el snapshot, es un bug de arquitectura.

**Matiz (añadido en el chunk ownership):** "primitivo" es relativo al límite del sistema, no a la realidad. Un dato ya agregado en origen (consenso de analistas, `shares_float`) que nosotros no podemos descomponer se guarda tal cual — ver `decisiones-modelo-ownership.md` §0.

---

## 1. Identidad del instrumento: COMPANY / SECURITY / LISTING

Se separan tres conceptos que los modelos amateur aplanan en uno:

- **COMPANY** — el negocio (empresa legal). Atributos de la empresa entera.
- **SECURITY** — el instrumento emitido (una clase de acción). Identificado por ISIN.
- **LISTING** — dónde y cómo cotiza esa security (bolsa + ticker + divisa).

**Por qué:** una empresa puede tener varias clases de acción (doble clase: GOOGL/GOOG), y cada clase puede cotizar en varias bolsas (multi-listing: Shell en Londres y Ámsterdam). Solo esta separación resuelve ambos casos de forma **estructural**, no con parches.

- Doble clase = **1 COMPANY, N SECURITY**.
- Multi-listing = **1 SECURITY, N LISTING**.

### Sub-decisiones
- `lei` y `cik` únicos pero **nullables**: no tienen cobertura universal (muchas europeas sin CIK, microcaps sin LEI). No sirven como clave de matching principal.
- **Una sola taxonomía sectorial canónica.** Se mapea todo a ella en la ingesta. No se guarda `sector_taxonomy` como campo suelto por empresa.
- **`COMPANY.company_id` es nullable en `SECURITY`** desde el chunk ETF: un ETF no tiene empresa operativa. Ver `decisiones-modelo-etf.md` §1 (invariante `ASSET_TYPE.requires_company`, enforcado por trigger, no por CHECK).

---

## 2. Fundamentales cuelgan de COMPANY (no de SECURITY)

Los estados financieros absolutos (ingresos, beneficio neto, EBITDA, deuda, fondos propios, flujo de caja) pertenecen a la **empresa**, no a la clase de acción.

- **`fundamentals` → COMPANY.**
- **`FUNDAMENTALS.currency TEXT NOT NULL`** = divisa de reporte (el `currency_symbol` de EODHD). **Independiente de la `quote_currency` del listing:** una empresa puede reportar en EUR y cotizar como ADR en USD, o reportar en GBP mientras su listing en Londres cotiza en GBX. Sin esta columna, la capa de lectura asume (mal) reporte = cotización y revienta los ratios cross-currency en silencio.
- **`shares_outstanding` (por periodo) → SECURITY** (cada clase tiene su número de acciones).
- **EPS, P/E, capitalización y todo per-share → derivados**, no almacenados en el modelo normalizado. Se materializan solo en el snapshot.
- **`fundamentals_source_security_id` (auto-FK) → ELIMINADO.** No hacía falta: el "compartir fundamentales entre clases" ocurre naturalmente porque ambas securities apuntan a la misma company.

**Frontera empresa/clase:** COMPANY guarda los estados absolutos; SECURITY guarda las acciones de su clase; el per-share se calcula cruzando ambos (EPS = beneficio ÷ acciones de esa clase).

**Regla de materializador — reconciliación de divisa:** todo ratio que cruce una magnitud de FUNDAMENTALS (o de DIVIDEND) con una de precio debe **convertir divisas primero, con el fx de la fecha correcta**. P/E = precio (`quote_currency`) ÷ EPS (derivado de `net_income` en `FUNDAMENTALS.currency`): si difieren, se reconcilia antes de dividir. Aplica igual al dividendo (usa su propia `DIVIDEND.currency`, no la del listing).

### 2.1 Point-in-time: FUNDAMENTALS es bitemporal

Requisito cerrado al inicio (trazabilidad, evitar look-ahead bias). `period_end` dice *qué periodo cubre* el dato; **no** dice *cuándo se supo*. La brecha entre ambos es donde vive el look-ahead bias: una empresa cierra un trimestre en diciembre pero lo publica a finales de enero; un screener que use el dato de diciembre el 15 de enero usa información del futuro.

- **`reported_at DATE` en FUNDAMENTALS** = cuándo se conoció/publicó el dato.
- **PK = `id` sintético + `UNIQUE (company_id, period_end, period_type, reported_at)`.** Con `reported_at` en la clave, un restatement (corrección de un trimestre ya publicado) es una **fila nueva** con `reported_at` posterior, conservando la anterior.
- **Reconstrucción "qué sabía el screener el día D":** la fila con `reported_at <= D` más reciente para ese `(company_id, period_end, period_type)`.
- **Dos ejes independientes:** `period_end` (periodo que cubre) y `reported_at` (cuándo se conoció). Tabla **bitemporal** — patrón distinto de "snapshot-temporal" (ver `decisiones-modelo-ownership.md` §1): aquí sí hay restatement real.
- **`SHARES_OUTSTANDING`:** mismo patrón por consistencia (prioridad menor).

**Procedencia de la fecha — `reported_at_source`.** Un booleano "¿estimado?" se queda corto; la pregunta al depurar es "¿de dónde salió?". Dominio cerrado (`TEXT + CHECK`, no `ENUM` nativo — añadir un valor futuro es un `ALTER` de constraint, no alterar un tipo):

- `provider` — EODHD dio la fecha de publicación explícita.
- `provider_derived` — deducida de otro dato de fecha fiable del proveedor.
- `estimated` — fallback por regla (`period_end` + desfase). **`DEFAULT`**: el default seguro es el menos fiable.
- `manual` — corregida/introducida a mano.
- `cross_checked` — confirmada contra 2ª fuente. Definido desde ya aunque no se pueble hasta tener 2º proveedor.

Descartados: `unknown`/`null` (si no sabes procedencia es `estimated` o es bug de ingesta); `backfilled`/`migrated` (eso es metadata de ingesta, otro eje). Aplica igual a `SHARES_OUTSTANDING`.

**Nota de realidad:** EODHD no siempre da la fecha de publicación real de cada línea histórica. Donde falte, fallback (`period_end` + ~45 días) marcado como `estimated`. El modelo permite point-in-time desde el día uno porque retrofitear bitemporalidad con datos ya dentro es una migración muy dolorosa.

---

## 3. Un solo listado primario garantizado

`is_primary_listing` (booleano) es lo que consulta el screener para mostrar cada security **una sola vez**.

**Riesgo:** un booleano no impide dos primarios o ninguno por security → reaparecen los duplicados.

**Decisión:** índice único parcial (`UNIQUE ... WHERE is_primary_listing`) que fuerza **como máximo uno** por security.

---

## 4. Tipo de activo como dato, no como código

`ASSET_TYPE` con flag `in_screener_scope`. El filtro "fuera warrants, SPACs, preferentes…" es **dato en una tabla**, no lógica hardcodeada.

**Por qué:** incluir ETFs el día de mañana = cambiar un booleano en una fila, no desplegar código. El screener hace join y filtra `WHERE in_screener_scope`.

**Extensión (chunk ETF):** `ASSET_TYPE` ganó una segunda columna de comportamiento-como-dato, `requires_company BOOLEAN`, que gobierna si `SECURITY.company_id` puede/debe ser NULL. Mismo patrón, segundo uso. Ver `decisiones-modelo-etf.md` §1.

---

## 5. Precios: fuente de verdad = bruto + eventos (Opción B)

El precio ajustado **no es un dato, es una vista**: cambia cada vez que hay un nuevo split (el ajuste se propaga hacia atrás sobre toda la serie). El bruto no cambia nunca.

- **`prices_daily` → LISTING.** Guarda **solo el precio bruto**, en divisa de cotización. Inmutable.
- **Series ajustadas** (por splits; y por splits+dividendos / total return) → **derivadas** de bruto + eventos, materializadas en la capa de lectura.

**Uso de cada serie:**
- **Bruto** → auditoría / fuente de verdad. Permite reconstruir los ajustados si un ajuste sale mal.
- **Ajustado por splits** → gráficos e indicadores técnicos (RSI, medias, 52w).
- **Ajustado splits+dividendos (total return)** → rendimiento real (imprescindible por el ángulo europeo, muchas empresas con dividendo).

Se descartó materializar las tres columnas en `prices_daily` por la reescritura histórica masiva en cada evento. Refuerzo: la propia doc de EODHD advierte de no tratar nunca el `adjusted_close` como estable (se recalcula retroactivo) — exactamente el motivo de esta decisión.

### 5.1 Eventos corporativos: dos tablas, no una genérica

Se **descarta** una tabla `CORPORATE_ACTION` polimórfica (split y dividend solo comparten `security_id` y `ex_date`, el resto quedaría nullable-por-tipo). Se separan en dos tablas densas, ambas colgando de SECURITY:

- **`STOCK_SPLIT`** (`security_id`, `ex_date`, `split_numerator`, `split_denominator`).
- **`DIVIDEND`** (`id`, `security_id`, `ex_date`, `declaration_date`, `record_date`, `payment_date`, `period`, `amount_native`, `currency`).

Deja hueco para más tipos (spin-off…) como tablas propias, sin ensuciar una tabla ancha.

### 5.2 Dividendo: guardar el importe NATIVO, no el ajustado

EODHD `/api/div/` da dos campos: `unadjustedValue` (lo que se pagó ese día, inmutable) y `value` (restatado a las acciones de hoy, se recalcula con cada split nuevo — mismo comportamiento que `adjusted_close`).

- **`DIVIDEND.amount_native` = `unadjustedValue`.** El dividendo ajustado se **deriva** en la capa de lectura.
- **`currency` NO es opcional:** un dividendo puede pagarse en divisa distinta a la de cotización (ADRs, reporte vs. reparto).
- De las cuatro fechas, **solo `ex_date` entra en el cálculo** de ajuste. `declaration/record/payment_date` son metadata de display/calendario.

### 5.3 Split: guardar numerador y denominador, no un factor

El ratio de EODHD es un string `"N/M"` y **no siempre es entero limpio** (`"1748175.000000/1000000.000000"` por reorganizaciones). Colapsarlo a un `numeric` único es una derivación con pérdida, y un factor redondeado **acumula deriva** aplicado en cascada sobre series largas.

- **`STOCK_SPLIT.split_numerator` / `split_denominator`** como `numeric` (tal cual del proveedor).
- **Naming deliberado:** se descartó `split_from`/`split_to` por ser ambiguo (no comunica cuál es numerador). `numerator`/`denominator` mapea directo a la operación de lectura.
- **Convención anclada:** un split 4:1 (una acción → cuatro) → `split_numerator = 4`, `split_denominator = 1`. Factor = `numerator / denominator` = 4. El precio histórico se divide por 4 hacia atrás.

### 5.4 Invariante: una sola cadena de factores de split

El precio total-return y el dividendo ajustado deben derivarse con **la misma cascada de factores de split**. Si usan cadenas distintas, se descuadran entre sí y el rendimiento total sale inconsistente. Regla: **una única función de factores acumulados**, consumida por precio-TR y por dividendo ajustado.

---

## 6. Divisas: fx_rates

- **Base = EUR.** Unidad interna de referencia. La fuente de verdad guarda cada cosa en su **divisa nativa**; la conversión a EUR ocurre solo en la materialización del snapshot. Cambiar la base = cambiar una constante y re-materializar.
- **Divisa fraccionaria (GBX y similares) = fila propia** en `fx_rates`, con su tipo a EUR ya correcto. El "/100 de los peniques de Londres" vive **dentro del tipo de cambio de esa fila**, no en una rama de código. Cero casos especiales en el materializador.
- **Forward-fill** para días sin tipo (fines de semana, festivos): la conversión toma el `fx` con fecha `<= date` más reciente.

Estructura: entidad de referencia global, PK `(currency, date)`, `rate_to_base`.

---

## 7. Bolsas: identidad = MIC real, no código de proveedor

Verificado contra la doc de EODHD: su código de exchange **no es una bolsa**. `US` es un agregado de NYSE + NASDAQ + OTC (MICs XNAS, XNYS, OTCM); el sufijo del símbolo (`AAPL.US`) es el código de EODHD, no un MIC; y `OperatingMIC` es null en las bolsas virtuales. El MIC operativo real de un valor se resuelve **a nivel de símbolo**, no de exchange.

- **`EXCHANGE` = la bolsa real, identidad `mic` (ISO 10383).** Una fila por XNAS, XNYS, XLON, XMAD… **No** una fila por `US`.
- **El `exchange_id` del LISTING se resuelve del sub-exchange a nivel de símbolo** durante la ingesta, no del código del path.
- **El código de proveedor NO va en `EXCHANGE`.** Es logística de descarga, no identidad. Se guarda lo mínimo para re-pedir el dato: **`LISTING.provider_symbol`** (`AAPL.US`).

**Diferido al chunk de trazabilidad (ver `README.md` → pendiente global):** tabla de traducción código-proveedor↔MIC; resolución sub-exchange del símbolo `.US` en la ingesta.

---

## Estado de la arquitectura

- **Fuente de verdad** (núcleo + `ownership` + `etf`): mínima, inmutable, en divisa/forma nativa.
- **Capa de lectura** (`screener_snapshot`): proyección congelada, derivada, optimizada para lectura. **Pendiente de diseñar.**
- **Noticias** (`modelo-noticias.md`): subsistema aparte, no fuente de verdad de rigor.

Pendientes globales (payload crudo, log de correcciones, earnings, capa de validación, capa de lectura) consolidados en `README.md` — no se repiten en cada chunk.
