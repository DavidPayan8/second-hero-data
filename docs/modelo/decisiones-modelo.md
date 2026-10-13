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

### 2.0 De qué campo del proveedor sale cada línea (P14, 2026-10-13)

Verificado con `fundamentals` real de AAPL, TSLA y AMZN (453 periodos). La correspondencia vive en **un único sitio del código** (`LINE_MAP`) y es la oficial mientras no se vea un caso que la contradiga:

| Columna | Campo EODHD | Nota |
|---|---|---|
| `revenue`, `gross_profit`, `ebitda`, `operating_income`, `net_income` | `Income_Statement`: `totalRevenue`, `grossProfit`, `ebitda`, `operatingIncome`, `netIncome` | |
| `operating_cf` | `Cash_Flow.totalCashFromOperatingActivities` | |
| `capex` | `Cash_Flow.capitalExpenditures` | **Positivo = salida de caja**, tal cual lo da EODHD (453 de 453 periodos positivos). VISTAS resta: FCF = `operating_cf` − `capex`. |
| `total_debt` | `Balance_Sheet.shortLongTermDebtTotal` | El total **que da el proveedor**, ya agregado en origen. Vacío en 76 de 453 periodos → NULL. |
| `short_term_debt`, `long_term_debt` | `Balance_Sheet.shortTermDebt`, `longTermDebt` | **Columnas nuevas.** Son primitivos del proveedor y cubren 50 de los periodos en que falta el total. |
| `cash` | `Balance_Sheet.cash` | Vacío en 16 → NULL. `cashAndShortTermInvestments` es otra magnitud: no se usa como sustituto. |
| `total_equity`, `total_assets` | `Balance_Sheet.totalStockholderEquity`, `totalAssets` | |

- **El escritor no rellena `total_debt` con `short_term_debt + long_term_debt`.** No son la misma magnitud: con los tres informados, la suma no coincide con el total en más de 150 periodos (el total del proveedor incluye otras partidas). Rellenar mezclaría dos definiciones en la misma serie. Si VISTAS quiere un respaldo cuando falta el total, lo decide y lo marca allí.

**Frontera empresa/clase:** COMPANY guarda los estados absolutos; SECURITY guarda las acciones de su clase; el per-share se calcula cruzando ambos (EPS = beneficio ÷ acciones de esa clase).

**Regla de materializador — reconciliación de divisa:** todo ratio que cruce una magnitud de FUNDAMENTALS (o de DIVIDEND) con una de precio debe **convertir divisas primero, con el fx de la fecha correcta**. P/E = precio (`quote_currency`) ÷ EPS (derivado de `net_income` en `FUNDAMENTALS.currency`): si difieren, se reconcilia antes de dividir. Aplica igual al dividendo (usa su propia `DIVIDEND.currency`, no la del listing).

### 2.1 Point-in-time: FUNDAMENTALS es bitemporal

Requisito cerrado al inicio (trazabilidad, evitar look-ahead bias). `period_end` dice *qué periodo cubre* el dato; **no** dice *cuándo se supo*. La brecha entre ambos es donde vive el look-ahead bias: una empresa cierra un trimestre en diciembre pero lo publica a finales de enero; un screener que use el dato de diciembre el 15 de enero usa información del futuro.

- **`reported_at DATE` en FUNDAMENTALS** = cuándo se conoció/publicó el dato.
- **PK = `id` sintético + `UNIQUE (company_id, period_end, period_type, reported_at)`.** Con `reported_at` en la clave, un restatement (corrección de un trimestre ya publicado) es una **fila nueva** con `reported_at` posterior, conservando la anterior.
- **Reconstrucción "qué sabía el screener el día D":** la fila con `reported_at <= D` más reciente para ese `(company_id, period_end, period_type)`.
- **Dos ejes independientes:** `period_end` (periodo que cubre) y `reported_at` (cuándo se conoció). Tabla **bitemporal** — patrón distinto de "snapshot-temporal" (ver `decisiones-modelo-ownership.md` §1): aquí sí hay restatement real.
- **`SHARES_OUTSTANDING`:** mismo patrón por consistencia (prioridad menor).
- **`reported_at` cuando los tres estados de un periodo traen `filing_date` distintas:** se usa la **más tardía**, con `reported_at_source = 'provider'`. Así la fila no se usa antes de estar completa.
- **Valores distintos para una clave ya guardada (misma `filing_date`) (P16, 2026-10-13):** se **acepta la corrección** (UPDATE) y se emite `FUNDAMENTALS_REVISED` (`detail` con solo las columnas cambiadas, `old`/`new`, conservando el `old` del primero). Una línea antes NULL que ahora llega informada se completa **en silencio**. Por qué no conservar lo guardado: la fila representa *esa presentación* (`filing_date`); si el proveedor corrige cómo la leyó, la lectura corregida es la verdad de esa misma presentación, y un backtest debe verla en su fecha original. Por qué no fila nueva con el día de captura: `reported_at` es cuándo lo supo el mercado, no cuándo lo vimos nosotros, y mezclar los dos ejes rompe el point-in-time. Un **restatement real** llega con `filing_date` posterior → fila nueva, sin finding. Misma lógica que precios (§5, P13) y eventos corporativos (§5.5).

**Procedencia de la fecha — `reported_at_source`.** Un booleano "¿estimado?" se queda corto; la pregunta al depurar es "¿de dónde salió?". Dominio cerrado (`TEXT + CHECK`, no `ENUM` nativo — añadir un valor futuro es un `ALTER` de constraint, no alterar un tipo):

- `provider` — EODHD dio la fecha de publicación explícita.
- `provider_derived` — deducida de otro dato de fecha fiable del proveedor.
- `estimated` — fallback por regla (`period_end` + desfase). **`DEFAULT`**: el default seguro es el menos fiable.
- `manual` — corregida/introducida a mano.
- `cross_checked` — confirmada contra 2ª fuente. Definido desde ya aunque no se pueble hasta tener 2º proveedor.

Descartados: `unknown`/`null` (si no sabes procedencia es `estimated` o es bug de ingesta); `backfilled`/`migrated` (eso es metadata de ingesta, otro eje). Aplica igual a `SHARES_OUTSTANDING`.

**Nota de realidad:** EODHD puede guardar una cifra **reexpresada** con la fecha de la presentación **original** (visto en AAPL FY2009 con la SEC). Eso es look-ahead escondido: el cruce con la SEC lo detecta (`decisiones-modelo-validacion.md` §7) y su frecuencia se mide con el plan de pago antes de decidir si se corrige `reported_at`. Además, EODHD no siempre da la fecha de publicación real de cada línea histórica. Donde falte, fallback (`period_end` + ~45 días) marcado como `estimated`. El modelo permite point-in-time desde el día uno porque retrofitear bitemporalidad con datos ya dentro es una migración muy dolorosa.

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
  - **Qué significa "inmutable" (P13, 2026-10-13):** que **nosotros** nunca reescribimos el bruto (ni por splits, ni por dividendos, ni por nada que derivemos). **No** significa que el proveedor no pueda corregirlo. Visto en vivo: la primera captura de una sesión trae un volumen provisional que EODHD corrige después (`AAPL.US` 2026-10-09: 37.821.157 → 37.881.200, con el `close` igual; `VTI.US` igual). Quedarse con el primer valor visto guardaría para siempre el provisional.
  - **Regla:** una revisión del proveedor **se acepta** (se actualiza la fila), con la misma lógica que `CORPORATE_EVENT_CHANGED` en dividendos y splits:
    - Cambio **solo de `volume`** en las **últimas N sesiones** de ese listing: se acepta **en silencio**. Es el asentamiento normal del volumen consolidado. N = 5, provisional, en un único sitio.
    - Cualquier cambio de `open`/`high`/`low`/`close`, o de `volume` fuera de esa ventana: se acepta y emite **`PRICE_REVISED`** (`warning`, objetivo `{listing_id, date}`, `detail` con anterior y nuevo; como en `CORPORATE_EVENT_CHANGED`, si ya hay uno abierto se conserva el `old` del primero).
    - El valor anterior no se pierde del todo: sigue en el `RAW_PAYLOAD` de la captura anterior mientras dure su retención.
  - **Descartado:** conservar siempre el guardado (deja el volumen provisional y un finding por día reciente de cada símbolo); retrasar la captura de la última sesión (el screener necesita el cierre de ayer).
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

### 5.5 Clave natural de los eventos y correcciones del proveedor

Decidido al implementar la migración `003_hechos` (2026-10-10, propuesta P5). Los eventos tienen `id` sintético, pero los escritores del normalizador tienen que ser idempotentes, así que cada tabla lleva una clave natural:

- **`STOCK_SPLIT`: `UNIQUE (security_id, ex_date)`.** No hay dos splits de un mismo valor el mismo día.
- **`DIVIDEND`: `UNIQUE (security_id, ex_date)`.** Ni el importe ni `period` entran en la clave:
  - **El importe no**, porque si el proveedor corrige un importe aparecería una segunda fila y el total-return contaría el dividendo dos veces.
  - **`period` tampoco** (corrige una primera versión de esta decisión que lo incluía). Es una etiqueta que el proveedor puede rellenar más tarde: viene vacía en el 10–56 % de las filas según el valor (AAPL 9/92, SHEL 58/104, SAP 18/32, ITX 20/47) y a veces como `"Unknown"`. Si EODHD completara después esas etiquetas, cada dividendo cambiaría de clave y se duplicaría.

**Dos dividendos con la misma fecha ex** (ordinario y extraordinario el mismo día) no caben en la clave. Si una misma respuesta del proveedor trae dos o más filas para el mismo `(security, ex_date)`, el escritor **no escribe esa fecha** y emite el finding `DIVIDEND_SAME_EX_DATE` (`structural`, `warning`) con todas las filas en `detail`, para revisión. Como la fila no existe, el finding apunta al crudo: `target_table='raw_payload'`. No se elige una al azar ni se suman. En 5 valores y 301 dividendos capturados no ocurre ni una vez; si aparece con frecuencia, se amplía el modelo.

**Fuente única: el listing primario** (2026-10-13). El proveedor devuelve dividendos y splits por símbolo, y una security puede tener varios listings (P12; p. ej. `AAPL.US` y `0R2V.LSE`). Si cada payload escribiera sobre la security, dos listings que discrepen harían oscilar el evento y emitirían `CORPORATE_EVENT_CHANGED` en cada captura. Por eso **solo se capturan y se escriben `div`/`splits` del listing primario**; un payload de otro listing de la misma security se marca leído y se salta (se cuenta). Si cambia el primario, la siguiente captura usa el nuevo, y una diferencia real con lo guardado sale como `CORPORATE_EVENT_CHANGED`, que es lo que debe pasar.

**Respuestas incompletas o contradictorias, siempre con finding (nunca en silencio):**
- Dos splits con la misma fecha y ratios distintos en una respuesta → no se escribe esa fecha y se emite **`SPLIT_SAME_EX_DATE`** (`structural`, `warning`, objetivo `raw_payload`), igual que `DIVIDEND_SAME_EX_DATE`.
- Un dividendo sin `unadjustedValue` o sin `currency` → no se crea (criterio de NULL: un importe sin unidad es peligroso) y se emite **`CORPORATE_EVENT_INCOMPLETE`** (`structural`, `warning`, objetivo `raw_payload`, con las filas en `detail`). Un dato que se descarta tiene que dejar rastro.

**Correcciones del proveedor.** Un hecho puntual no debería cambiar. Si un refetch trae un evento ya guardado con otro valor (`amount_native`/`currency` en un dividendo, numerador/denominador en un split), el escritor **actualiza** la fila y emite el finding `CORPORATE_EVENT_CHANGED` (`data_quality`, `warning`) con el valor anterior y el nuevo en `detail`. Se acepta la corrección, pero queda rastro y se revisa. Los cambios en metadatos (`period`, `declaration_date`, `record_date`, `payment_date`) se actualizan sin finding.

**Verificado: el `date` de `div/` es la fecha ex.** En `div/AAPL.US` (92 filas) la distancia de `date` a `recordDate` sigue los ciclos de liquidación de EEUU: 4 días hábiles en T+5 (hasta 1995), 2 en T+3 (hasta 2017), 1 en T+2 (hasta 28/05/2024) y 0 en T+1. Las desviaciones de un día caen junto al 11 de noviembre (Veterans Day: la bolsa abre pero no se liquida); explicación coherente, no contrastada con un calendario.

**Tipos:** las cantidades (acciones, volumen) son `numeric`, como los importes. `bigint` solo para identificadores; un valor fraccionario del proveedor no puede tumbar la ingesta.

---

### 5.6 Regla general: correcciones del proveedor y lagunas sistemáticas (2026-10-13)

Resume lo decidido caso a caso (P13, P16, §5.5) para que cada escritor nuevo no reabra la pregunta:

- **Misma clave natural, valor distinto → gana la última lectura del proveedor** (UPDATE). Nunca se conserva la primera solo por haber llegado antes.
- **Rastro:** con finding (`PRICE_REVISED`, `FUNDAMENTALS_REVISED`, `CORPORATE_EVENT_CHANGED`) en las tablas que alimentan el núcleo financiero (precios, FX, fundamentales, acciones, eventos). En las series observadas por día (`as_of_date`: holders, analistas, ownership agregada, short interest, ETF) la corrección dentro del mismo día se aplica **en silencio**: su historia es la sucesión de días, no las versiones de un día. El valor anterior queda en `RAW_PAYLOAD`.
- **NULL que pasa a valor:** se completa en silencio. **Valor que llega vacío:** no borra lo guardado.
- **Laguna sistemática del proveedor** (le falta un campo de forma generalizada y nadie puede arreglarlo revisando: divisa del estimado futuro, ids de holder, cantidad de muchos insiders): **se cuenta en el resumen de la corrida y se documenta en `verificacion-eodhd.md`, sin finding.** Un finding es para lo que una persona puede revisar y resolver; mil findings idénticos por corrida esconden los que importan.

## 6. Divisas: fx_rates

- **Base = EUR.** Unidad interna de referencia. La fuente de verdad guarda cada cosa en su **divisa nativa**; la conversión a EUR ocurre solo en la materialización del snapshot. Cambiar la base = cambiar una constante y re-materializar.
- **Divisa fraccionaria (GBX y similares) = fila propia** en `fx_rates`, con su tipo a EUR ya correcto. El "/100 de los peniques de Londres" vive **dentro del tipo de cambio de esa fila**, no en una rama de código. Cero casos especiales en el materializador.
- **Forward-fill** para días sin tipo (fines de semana, festivos): la conversión toma el `fx` con fecha `<= date` más reciente.

Estructura: entidad de referencia global, PK `(currency, date)`, `units_per_base`.

### 6.b Qué se guarda en `fx_rates` (2026-10-13, al escribir el escritor de FX)

- **`units_per_base` = la cotización `EURxxx` del proveedor tal cual** (`EURUSD.FOREX` cierra en ~1,12 → `USD` guarda 1,12): unidades de la divisa por 1 EUR. Convertir a EUR = **dividir** por ella. Antes se llamaba `rate_to_base` y se pensó como `1 / cierre`; eso es guardar un derivado de la cotización, y además `1/x` en `numeric` redondea, de modo que el valor guardado ya no coincide con el del payload. Se renombra (migración nueva) y se guarda el primitivo.
- **`GBX` = cotización `EURGBP` × 100** (peniques por 1 EUR): multiplicación exacta, sin redondeo. Factor en `src/fx/subunits.ts` (§6.a).
- **`EUR` no tiene filas.** Es la base: por definición, 1 EUR = 1 EUR. El materializador trata `currency = base` como factor 1 sin buscar fila. Escribir filas de un 1 constante sería guardar lo derivable.
- **Revisiones del proveedor:** como en precios (§5): en las últimas N sesiones se aceptan en silencio (el cierre del día en curso se mueve mientras cotiza); más atrás se aceptan y emiten `PRICE_REVISED` con objetivo `{currency, date}`. N en un único sitio, provisional.

### 6.a Precio en subunidad y dividendo en unidad (P2, 2026-10-12)

Verificado en vivo: `eod/SHEL.LSE` cierra en ~3793,5 (peniques, GBX) y `div/SHEL.LSE` trae `currency: "GBP"`. **Se guarda cada cosa tal como llega; nadie divide entre 100 en la ingesta.** Es la opción (b) de P2, y ya era lo que pedían este §6 y la regla de reconciliación de divisa del §2:

- **`PRICES_DAILY`** en la unidad del proveedor, sin tocar. Su divisa es `LISTING.quote_currency`.
- **`LISTING.quote_currency`** sale del campo de divisa **por símbolo** de `exchange-symbol-list` (`Currency`), nunca de `EXCHANGE.default_currency` (identidad §8). Para Londres tiene que decir `GBX` en los valores que cotizan en peniques. **Pendiente de comprobar con el payload** de `exchange-symbol-list/LSE` antes de escribir el normalizador de listings: si allí dijera `GBP` mientras `eod` llega en peniques, el campo no serviría y P2 se reabre (no se adivina por la magnitud del precio).
- **`DIVIDEND.currency`** la de cada fila (`GBP`). Un dividendo en GBP de un listing en GBX no es un error; lo reconcilia el materializador con FX, como cualquier otro cruce de divisas.
- **`FX_RATES` tiene una fila `GBX`** con su tipo a EUR = tipo de `GBP` ÷ 100, generada por el escritor de FX a partir de la fila `GBP` del mismo día. La lista de subunidades (`GBX → GBP, 100`) vive en **un único sitio** del código, como decisión provisional anotada en el registro; hoy solo hace falta GBX. Así el materializador no tiene ningún caso especial.
- `CURRENCY_COHERENCE` ya cubre el caso: un listing en `GBX` sin camino de FX genera un finding.

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
