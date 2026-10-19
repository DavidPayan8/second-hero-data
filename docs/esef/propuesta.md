# P19 — ESEF/UKSEF (filings.xbrl.org) como segunda fuente europea

> **Estado:** abierta. Decisiones de diseño tomadas el 2026-10-19 (sección 11). Spike ejecutado el mismo día (`docs/esef/spike-resultado.md`) y aplicado aquí; siguen abiertos Q4–Q7, que dependen de tener fundamentales de EODHD (el plan actual es `free`).
> Entrada resumida en `docs/propuestas-cambio-modelo.md` (P19).

## 1. Objetivo

Usar los informes financieros anuales en Inline XBRL de las cotizadas europeas (ESEF en la UE/EEE, UKSEF en el Reino Unido) como **segunda fuente** de los fundamentales anuales de EODHD, con el mismo papel que ya tiene la SEC para EEUU (`src/validation/secSecondSource.ts`).

- **Sí hace:** capturar los informes, guardar el cuerpo crudo exacto, extraer un conjunto cerrado de hechos y emitir findings cuando no cuadran con `FUNDAMENTALS`.
- **No hace:** escribir en `FUNDAMENTALS` ningún valor, sustituir a EODHD ni alimentar VISTAS o ranking.

Es la fuente primaria: una discrepancia contra el informe que publica la propia empresa dice algo sobre la calidad de EODHD.

## 2. Alcance

| Dimensión | Decisión | Comentario |
|---|---|---|
| Ejercicios | **FY2021 en adelante** | La mayoría de Estados (y el Reino Unido) retrasó un año la obligación; FY2020 solo existe en 4 países o en voluntarios. Se descarta. |
| Periodicidad | Solo anual (`period_type = 'A'`) | ESEF no cubre trimestrales ni semestrales. No valida TTM. |
| Mercados | Mercados regulados UE/EEE **y Main Market del Reino Unido** | Fuera: MTF (BME Growth, Euronext Growth, First North, **AIM**…). |
| Estados | Consolidados IFRS | Sin consolidado apenas hay datos etiquetados. |

La cobertura será parcial y tiene que verse: una empresa sin informe es **no validable**, no "validada".

**Alemania queda fuera de la fuente.** El spike midió 0 filings de `DE` en `filings.xbrl.org` (ni SAP, ni Siemens, ni Allianz, ni ningún otro alemán). Las empresas alemanas son **no validables** con el motivo «fuente sin cobertura», visible en el panel (sección 9). No es un fallo de identidad ni de captura y no se corrige desde aquí; si la fuente incorpora Alemania, entra sin cambiar el diseño.

## 3. Fuente

- API pública `https://filings.xbrl.org/api/filings` (JSON:API: `page[size]`, `page[number]`, `filter[country]=ES`, `sort=-processed`, `include=entity`).
- Por informe: paquete original, visor iXBRL y **xBRL-JSON** (generado con Arelle). Se ingiere el xBRL-JSON.
- Riesgos: no es oficial ni completa, puede tardar en incorporar informes, puede limitarse o retirarse (suscribirse a la lista `fxo-users`), muchos informes llegan con errores de validación.
- Medido en el spike (2026-10-19, `spike-resultado.md` Q1–Q2): sin clave ni límite de uso visible a ≤1 petición/s; `page[size]` acepta al menos 5000; el índice completo son 26 043 filings. **El `period_end` del índice no es fiable** (Unilever indexa FY2024 con `2025-02-13`; hay cierres en 2031 y 2032): el cierre real se saca de los hechos. **El índice mezcla informes anuales e intermedios** (Novo Nordisk: 23) y no los distingue. Un mismo informe llega por varios países y en varias versiones (`-0`, `-1`…).
- Respaldo futuro: OAM nacional (CNMV, FCA NSM…) y ESAP cuando exista.

## 4. Encaje con lo que ya hay

| Pieza | Se reutiliza | Nuevo |
|---|---|---|
| Captura | `ingestion_run` con `provider = 'esef'`, `raw_payload` + `payload_blob` (cuerpo exacto por hash), igual que `sec-capture` | Comando `npm run esef-capture` (dry-run por defecto, `--go` para llamar) |
| Identidad | `COMPANY.lei`, que ya rellena el normalizador desde `General.LEI` de EODHD | Solo si el spike muestra huecos: cruce LEI → ISIN (GLEIF) → `SECURITY.isin` |
| Comparación | Patrón de `secSecondSource.ts`: última versión de cada periodo, `cross_checked` si todo cuadra | Regla propia (ver 7.3) |
| Tolerancias | `src/validation/config.ts` (único sitio de umbrales) | Claves `esef*` |
| Findings | `data_quality_finding` (`status`, `resolved_by`, `resolved_at`) | Tipos nuevos en `validation_rule` |

Todo vive fuera del normalizador: `src/esef/` (cliente y extractor) y `src/validation/esefSecondSource.ts`. El normalizador no sabe que ESEF existe.

```
filings.xbrl.org ──esef-capture──▶ ingestion_run / raw_payload / payload_blob   (crudo, inmutable)
                                         │
                                  extractor (determinista, sin LLM, versionado)
                                         ▼
                                     esef_filing + esef_fact                      (proyección regenerable)
                                         │
                       validate ── esefSecondSource ◀── fundamentals (period_type 'A')
                                         ▼
                         data_quality_finding  (+ cross_checked en FUNDAMENTALS)
```

## 5. Identidad

1. **Camino principal:** LEI del informe = `COMPANY.lei`. Sin tablas nuevas.
2. **Hueco abierto (Q4):** `verificacion-eodhd.md` C1 solo comprobó `General.LEI` en EEUU, y el spike no pudo medirlo en Europa (plan `free`, sin fundamentals). Hasta tenerlo no se sabe si hace falta otro camino.
3. **GLEIF queda en reserva.** El spike lo probó con 4 LEI: funciona, pero devuelve **todos** los ISIN del emisor, deuda incluida (906 para Novo Nordisk, 1 813 para Shell). Solo se usaría **filtrando contra `SECURITY.isin`** (ISIN ya conocidos), nunca como «todos los ISIN del LEI». Un LEI, varios ISIN es normal (Volvo: clases A y B).
4. Un LEI del informe sin empresa → `ESEF_NO_MATCH` (no se crea nada). Nunca se escribe `COMPANY.lei` desde ESEF: identidad sigue siendo cosa del normalizador (`decisiones-modelo-identidad.md`).

## 6. Qué se compara

Solo columnas que **ya guarda** `FUNDAMENTALS` (no se compara lo que no almacenamos), con conceptos `ifrs-full` y hechos **sin dimensiones** (totales del grupo):

| Columna de `FUNDAMENTALS` | Concepto IFRS | Nota |
|---|---|---|
| `revenue` | `Revenue`; alternativa estándar `RevenueFromContractsWithCustomers` | Spike: 22/28 informes de no financieras con `Revenue`; el resto usa la alternativa o una extensión (`ESEF_UNMAPPED`). **No se compara en el sector financiero** (ver abajo) |
| `gross_profit` | `GrossProfit` | Spike: 18/28; muchas empresas no lo presentan. Sin concepto → no comparable. **No se compara en el sector financiero** |
| `operating_income` | `ProfitLossFromOperatingActivities` | No es obligatorio en IFRS; spike: 21/28. Sin concepto → no comparable. **No se compara en el sector financiero** |
| `net_income` | `ProfitLossAttributableToOwnersOfParent` | Mismo criterio que la SEC (atribuible a la matriz). Si el informe **solo** trae `ProfitLoss` (ASML y Novo Nordisk en el spike), se compara con él y el mismatch se clasifica aparte como `consolidated`, como en la SEC |
| `total_assets` | `Assets` | Spike: 28/28 |
| `total_liabilities` | `Liabilities` | Spike: solo 16/28; casi la mitad no lo etiqueta. Sin concepto → no comparable; **no se deriva** de `Assets − Equity` |
| `total_equity` | `EquityAttributableToOwnersOfParent` (y `Equity`) | Spike: 28/28. Qué recoge `totalStockholderEquity` de EODHD se decide con datos (Q5, abierta) |
| `cash` | `CashAndCashEquivalents` | Spike: 28/28 |
| `operating_cf` | `CashFlowsFromUsedInOperatingActivities` | Spike: 28/28 |
| `capex` | `PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities`; alternativas `PurchaseOfPropertyPlantAndEquipment…` y `PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities` | Spike: solo 14/28 con el estándar; el resto usa alternativas o extensiones, que se resuelven con `esef_concept_map`. `capex` se guarda positivo (P14): normalizar signo |

**Sector financiero.** Para las empresas cuyo `COMPANY.sector_id` es `financials` (taxonomía D3, `decisiones-modelo-taxonomia.md` §4.b; abarca `banking`, `insurance`, `capital_markets` y `specialty_finance`, y se lee del sector aunque `industry_id` sea NULL) **no se comparan `revenue`, `gross_profit` ni `operating_income`**: los bancos no usan `Revenue` y los otros dos no tienen un significado comparable. Se siguen comparando `net_income`, `total_assets`, `total_liabilities`, `total_equity`, `cash`, `operating_cf` y `capex`. Si `sector_id` es NULL no se sabe que es financiera y se aplica la regla de ausencia (7.3). Aseguradoras: **no medido** (sin muestra, Allianz no existe en la fuente).

**Ausencia no es discrepancia.** Un concepto que no aparece en el informe deja la columna en «no comparable»; nunca genera un finding de diferencia.

Fuera de la fase 1: `ebitda` (no es concepto IFRS), `total_debt`, `short_term_debt` y `long_term_debt` (sin concepto único en IFRS).

Extensiones: un concepto propio de la empresa no se adivina. Se emite `ESEF_UNMAPPED` y un admin lo asigna desde el panel (`esef_concept_map`).

## 7. Reglas de comparación

### 7.1 Emparejamiento
- Fila anual más reciente de cada `(company, period_end)` en `FUNDAMENTALS`, como en la SEC.
- Periodo: fin de ejercicio **calculado a partir de los hechos del informe** frente a `period_end`, con la misma ventana que la SEC (`secPeriodWindowDays`); el `period_end` del índice no se usa para emparejar (no es fiable). Si la ventana de 7 días basta no se pudo contrastar (Q5, abierta). Ejercicios partidos (p. ej. enero o septiembre) se cruzan por fecha de cierre.
- Solo informes **anuales**: el periodo principal tiene una duración de ~1 año (≥ 340 días). Los intermedios (el índice no los distingue) se descartan por duración, no por fecha.
- Duplicados: se agrupan por `(LEI, cierre real)`, **no por hash** (el spike encontró 1 732 grupos y solo 80 comparten `sha256`: el mismo informe llega por varios países y en varias versiones). Dentro del grupo se elige la versión con menos `error_count` y, a igualdad, la de `processed` más reciente.
- Reexpresiones: cada informe se compara con **su** periodo principal; las comparativas reexpresadas del año anterior son información, no error (como `restated` en la SEC).

### 7.2 Unidades
- **Moneda:** se compara en la moneda del informe. Si `FUNDAMENTALS.currency` es otra, finding de moneda y no se convierte.
- **Subunidades (Reino Unido):** si EODHD diera GBX donde el informe da GBP, se usa `src/fx/subunits.ts`; no se inventa un factor. Q6 sigue **abierta**: el spike midió que los informes vienen en USD (Shell, BP, AstraZeneca, HSBC), EUR (Unilever, Santander) o moneda local, nunca en GBX, pero no pudo ver la moneda de `FUNDAMENTALS` (plan `free`). Evidencia indirecta: EODHD da el precio de `SHEL.LSE` en peniques (GBX) y rotula su dividendo como GBP, mientras el informe es USD.
- **Escala:** xBRL-JSON da el valor completo (texto exacto, sin exponente) más `decimals`; el valor de EODHD se redondea a esa precisión antes de comparar.
- **Fechas:** en el xBRL-JSON el fin de un periodo y los instantes vienen como las 00:00 **del día siguiente** al cierre; el extractor resta un día.
- **Signo:** se normaliza `capex` (positivo = salida de caja).

### 7.3 Tolerancia y findings
- Bandas decididas a priori, en `VALIDATION_CONFIG`. Su revisión con datos reales (Q5) sigue **abierta**: el spike no tuvo fundamentales de EODHD, así que se mantienen tal cual:
  - |Δ| ≤ 0,1 % → cuadra
  - 0,1 % < |Δ| ≤ 2 % → discrepancia leve
  - |Δ| > 2 % → discrepancia grave
- Ojo: la SEC usa hoy una sola tolerancia (`secTolerance` = 0,5 %). Hay que decidir si se unifican.
- **Código de regla propio** (`ESEF_MISMATCH`), no `SECOND_SOURCE_MISMATCH`: el índice único parcial `(rule_code, target_table, target_key) WHERE status = 'open'` haría chocar un finding de la SEC y otro de ESEF sobre la misma fila (empresas europeas que también presentan en la SEC). La banda va en `detail`; la severidad sale del catálogo como en el resto de reglas.
- **Una magnitud sin dato en el informe** (concepto ausente, hecho nulo, columna excluida por sector) **se ignora**, igual que `secSecondSource.ts` con una magnitud sin dato en la SEC: no es un finding y no cuenta como que cuadra. Si ninguna magnitud se puede comparar, la fila queda como está.
- **`net_income` solo con `ProfitLoss`:** se compara, y si no cuadra el mismatch se clasifica aparte como `consolidated` (como la SEC); la clasificación va en `detail`, y la regla de `rowKind` de la SEC (el tipo de la fila es el de todos sus mismatches si coinciden) se reutiliza.
- Si todas las magnitudes comparables cuadran (y hay al menos una): `reported_at_source` pasa a `cross_checked`, como con la SEC.
- Códigos nuevos: `ESEF_MISMATCH` (data_quality), `ESEF_UNMAPPED` y `ESEF_NO_MATCH` (structural), todos `warning`.

## 8. Cambio de modelo — decidido: opción C, con condiciones

| Opción | Qué se guarda | Decisión |
|---|---|---|
| A | Solo findings | Descartada: no permite recomparar ni trabajar desde el panel |
| B | Crudo + índice + findings | Base de la C |
| **C** | **B + tabla de hechos extraídos** | **Elegida**: el panel de admin consulta, mapea y recompara sin reparsear JSON |

### 8.1 Excepción controlada a "no guardar lo derivable"
`esef_fact` **es derivable** del crudo. Se acepta porque el panel trabaja sobre ella, con tres condiciones:
1. El crudo (`payload_blob`) sigue siendo la fuente: `esef_fact` se puede vaciar y regenerar entera sin pérdida.
2. Cada fila lleva `extractor_version`; si cambia el extractor se regenera, no se parchea.
3. Nadie la edita a mano. Las decisiones de los admins van en sus propias tablas.

### 8.2 Tablas nuevas (columnas ajustadas con el spike; el DDL definitivo se escribe en la fase 1)
- `esef_filing`: `esef_filing_id`, `fxo_id` (único; lleva la versión `-n` de la presentación), `content_hash` (→ `payload_blob`), `index_sha256` (el `sha256` del índice, distinto del anterior), `lei`, `country`, `period_start` y `period_end` **reales, extraídos de los hechos**, `index_period_end` (el del índice, solo informativo), `processed_at`, `date_added`, `report_url`, `viewer_url`, `json_url`, `error_count`, `warning_count`, `inconsistency_count`, `ifrs_taxonomy` (versión, de `documentInfo`). Sin columna anual/intermedio ni «versión elegida»: se derivan de `period_start`/`period_end` y de `error_count`/`processed_at`. Moneda del informe: se decide al escribir el extractor (pueden convivir varias en un informe; Q6 abierta).
- `esef_fact`: `esef_filing_id`, `concept` (QName, p. ej. `ifrs-full:Revenue`), `is_extension`, `period_start`, `period_end` (cierre real: ya restado el día de más del xBRL-JSON; para un instante, `period_start` NULL), `value` (`numeric`, texto exacto), `decimals` (NULL si el hecho no lo trae), `unit`, `extractor_version`. **Guarda TODOS los hechos numéricos sin dimensiones** (decisión de David, 2026-10-19), no solo los de la tabla 6: los admins tienen que poder mapear extensiones desde el panel y una extensión fuera de la tabla no se podría mapear. Volumen medido en el spike: ≈ 5,1 M filas (13 638 informes anuales e intermedios `(LEI, cierre)` entre 2021-01 y 2026-06, ~350–380 hechos numéricos sin dimensiones por informe); la muestra son grandes cotizadas, así que es una cota alta. Se descartan los hechos con valor `null` (nil) y los que llevan dimensiones. Sigue siendo una proyección regenerable desde el crudo (8.1).
- `esef_concept_map`: `concept`, `lei` (NULL = global), `fundamentals_column`, `created_by`, `created_at`. Auditada como dimensión (T4).
- **Resolución de findings:** `data_quality_finding` ya tiene `status` (`reviewed`/`accepted`/`dismissed`), `resolved_by` y `resolved_at`. Falta el *porqué* (`eodhd_ok`, `esef_ok`, `ambos_mal`, `diferencia_esperada`). Opciones: (a) tabla `finding_resolution (finding_id, decision, note)`; (b) columna `resolution jsonb` en el finding. Se decide junto con el panel.

**Límite:** resolver un finding **solo registra la decisión**. Nada se escribe en `FUNDAMENTALS`. Corregir el dato de EODHD con ESEF (overrides) sería otra propuesta.

## 9. Panel de admin (lo que necesita de esta fuente)

1. Cobertura por empresa: validada / con discrepancias / no validable (motivo: MTF, sin consolidado, sin informe, sin LEI, **fuente sin cobertura** —Alemania, hoy—). Además, por columna: comparada / no comparable (concepto ausente, o excluida por sector financiero).
2. Cola de findings por severidad, país y concepto, con los dos valores lado a lado y enlace al visor iXBRL.
3. Resolver `ESEF_NO_MATCH` (identidad) y `ESEF_UNMAPPED` (conceptos); guardar un mapeo recompara lo afectado.
4. Estado de captura: últimos informes, errores de descarga y de validación.

El panel lo construye el otro equipo; aquí solo se fija qué datos expone la capa.

## 10. Fases

0. **Spike de solo lectura** (`docs/esef/spike.md`). Hecho el 2026-10-19 (`spike-resultado.md`); Q4–Q7 pendientes de fundamentales de EODHD.
1. Captura (`esef-capture`) sobre las tablas existentes + migración de `esef_filing` y `esef_fact` + extractor.
2. Regla `esefSecondSource` y códigos nuevos en el catálogo.
3. Lo que necesite el panel (8.2, resolución).
4. Más adelante: OAM nacional, ESAP, overrides.

## 11. Decisiones (2026-10-19) y abiertas

| # | Asunto | Estado |
|---|---|---|
| 1 | Persistencia | **Decidido:** opción C con las condiciones de 8.1 |
| 2 | Tolerancias | **Decidido a priori:** bandas de 7.3. Revisión con datos reales **abierta** (Q5, sin fundamentales de EODHD). Abierto: ¿unificar con `secTolerance`? |
| 3 | Empresas no validables | **Decidido:** visibles en el panel con su motivo; nuevo motivo «fuente sin cobertura» (Alemania) |
| 4 | Reino Unido (UKSEF) | **Decidido:** entra (Main Market) |
| 5 | FY2020 | **Decidido:** fuera; se empieza en FY2021 |
| 6 | Orden | **Decidido y cumplido:** spike antes de seguir con EODHD (ejecutado el 2026-10-19) |
| 7 | ¿Una resolución puede corregir la fuente de verdad? | **Abierto:** en esta fase no |
| 8 | Forma de guardar la resolución (8.2 a/b) | **Abierto** |
| 9 | ¿Hace falta GLEIF? | **Abierto, en reserva:** depende de Q4 (`General.LEI` de EODHD en Europa). Si se usa, solo filtrando contra `SECURITY.isin` |
| 10 | Alemania | **Decidido:** no validable, motivo «fuente sin cobertura» (0 filings `DE` en la fuente); se añade al panel |
| 11 | Qué guarda `esef_fact` | **Decidido:** todos los hechos numéricos sin dimensiones (≈ 5 M filas), para poder mapear extensiones desde el panel; proyección regenerable |
| 12 | Sector financiero | **Decidido:** `sector_id = financials` (D3) no compara `revenue`, `gross_profit` ni `operating_income` |
| 13 | Ausencia de concepto | **Decidido:** «no comparable», nunca un finding de diferencia (criterio de `secSecondSource.ts`) |
| 14 | `net_income` solo con `ProfitLoss` | **Decidido:** se compara y se clasifica aparte como `consolidated` |
| 15 | Deduplicación y periodo | **Decidido:** por `(LEI, cierre real)` y versión con menos errores; cierre sacado de los hechos, no del índice; solo informes de ~1 año |
| 16 | Q4 (`General.LEI` en Europa), Q5 (comparación real), Q6 (moneda de `FUNDAMENTALS` en UK), Q7 (CIK de ASML) | **Abiertos:** requieren fundamentales de EODHD (plan actual `free`) |
