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
| `revenue` | `Revenue` | Bancos y aseguradoras no usan `Revenue`: se medirá en el spike |
| `gross_profit` | `GrossProfit` | Muchas empresas no lo presentan |
| `operating_income` | `ProfitLossFromOperatingActivities` | No es obligatorio en IFRS; cobertura irregular |
| `net_income` | `ProfitLossAttributableToOwnersOfParent` | Mismo criterio que la SEC (atribuible a la matriz); `ProfitLoss` solo para clasificar `consolidated` |
| `total_assets` | `Assets` | |
| `total_liabilities` | `Liabilities` | |
| `total_equity` | `EquityAttributableToOwnersOfParent` (y `Equity`) | Qué recoge `totalStockholderEquity` de EODHD se decide con datos |
| `cash` | `CashAndCashEquivalents` | |
| `operating_cf` | `CashFlowsFromUsedInOperatingActivities` | |
| `capex` | `PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities` | `capex` se guarda positivo (P14): normalizar signo |

Fuera de la fase 1: `ebitda` (no es concepto IFRS), `total_debt`, `short_term_debt` y `long_term_debt` (sin concepto único en IFRS).

Extensiones: un concepto propio de la empresa no se adivina. Se emite `ESEF_UNMAPPED` y un admin lo asigna desde el panel (`esef_concept_map`).

## 7. Reglas de comparación

### 7.1 Emparejamiento
- Fila anual más reciente de cada `(company, period_end)` en `FUNDAMENTALS`, como en la SEC.
- Periodo: fin de ejercicio del informe frente a `period_end`, con la misma ventana que la SEC (`secPeriodWindowDays`) salvo que el spike diga otra cosa. Ejercicios partidos (p. ej. enero o septiembre) se cruzan por fecha de cierre.
- Duplicados: el mismo informe en varios países o idiomas se deduplica por hash.
- Reexpresiones: cada informe se compara con **su** periodo principal; las comparativas reexpresadas del año anterior son información, no error (como `restated` en la SEC).

### 7.2 Unidades
- **Moneda:** se compara en la moneda del informe. Si `FUNDAMENTALS.currency` es otra, finding de moneda y no se convierte.
- **Subunidades (Reino Unido):** si EODHD diera GBX donde el informe da GBP, se usa `src/fx/subunits.ts`; no se inventa un factor. A verificar en el spike (P2 quedó abierta precisamente por esto).
- **Escala:** xBRL-JSON da el valor completo más `decimals`; el valor de EODHD se redondea a esa precisión antes de comparar.
- **Signo:** se normaliza `capex` (positivo = salida de caja).

### 7.3 Tolerancia y findings
- Bandas decididas a priori (se revisan con los datos del spike), en `VALIDATION_CONFIG`:
  - |Δ| ≤ 0,1 % → cuadra
  - 0,1 % < |Δ| ≤ 2 % → discrepancia leve
  - |Δ| > 2 % → discrepancia grave
- Ojo: la SEC usa hoy una sola tolerancia (`secTolerance` = 0,5 %). Hay que decidir si se unifican.
- **Código de regla propio** (`ESEF_MISMATCH`), no `SECOND_SOURCE_MISMATCH`: el índice único parcial `(rule_code, target_table, target_key) WHERE status = 'open'` haría chocar un finding de la SEC y otro de ESEF sobre la misma fila (empresas europeas que también presentan en la SEC). La banda va en `detail`; la severidad sale del catálogo como en el resto de reglas.
- Si todas las magnitudes comparables cuadran: `reported_at_source` pasa a `cross_checked`, como con la SEC.
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

### 8.2 Tablas nuevas (provisionales; se cierran con el spike)
- `esef_filing`: `esef_filing_id`, `fxo_id`, `content_hash` (→ `payload_blob`), `lei`, `country`, `period_end`, `processed_at`, `report_url`, `viewer_url`, `validation_error_count`.
- `esef_fact`: `esef_filing_id`, `concept` (QName, p. ej. `ifrs-full:Revenue`), `is_extension`, `period_start`, `period_end` / `instant`, `value` (`numeric`, texto exacto), `decimals`, `unit`, `extractor_version`. Solo hechos sin dimensiones; volumen a medir en el spike.
- `esef_concept_map`: `concept`, `lei` (NULL = global), `fundamentals_column`, `created_by`, `created_at`. Auditada como dimensión (T4).
- **Resolución de findings:** `data_quality_finding` ya tiene `status` (`reviewed`/`accepted`/`dismissed`), `resolved_by` y `resolved_at`. Falta el *porqué* (`eodhd_ok`, `esef_ok`, `ambos_mal`, `diferencia_esperada`). Opciones: (a) tabla `finding_resolution (finding_id, decision, note)`; (b) columna `resolution jsonb` en el finding. Se decide junto con el panel.

**Límite:** resolver un finding **solo registra la decisión**. Nada se escribe en `FUNDAMENTALS`. Corregir el dato de EODHD con ESEF (overrides) sería otra propuesta.

## 9. Panel de admin (lo que necesita de esta fuente)

1. Cobertura por empresa: validada / con discrepancias / no validable (motivo: MTF, sin consolidado, sin informe, sin LEI).
2. Cola de findings por severidad, país y concepto, con los dos valores lado a lado y enlace al visor iXBRL.
3. Resolver `ESEF_NO_MATCH` (identidad) y `ESEF_UNMAPPED` (conceptos); guardar un mapeo recompara lo afectado.
4. Estado de captura: últimos informes, errores de descarga y de validación.

El panel lo construye el otro equipo; aquí solo se fija qué datos expone la capa.

## 10. Fases

0. **Spike de solo lectura** (`docs/esef/spike.md`). Antes de seguir con EODHD.
1. Captura (`esef-capture`) sobre las tablas existentes + migración de `esef_filing` y `esef_fact` + extractor.
2. Regla `esefSecondSource` y códigos nuevos en el catálogo.
3. Lo que necesite el panel (8.2, resolución).
4. Más adelante: OAM nacional, ESAP, overrides.

## 11. Decisiones (2026-10-19) y abiertas

| # | Asunto | Estado |
|---|---|---|
| 1 | Persistencia | **Decidido:** opción C con las condiciones de 8.1 |
| 2 | Tolerancias | **Decidido a priori:** bandas de 7.3; se revisan con el spike. Abierto: ¿unificar con `secTolerance`? |
| 3 | Empresas no validables | **Decidido:** visibles en el panel con su motivo |
| 4 | Reino Unido (UKSEF) | **Decidido:** entra (Main Market) |
| 5 | FY2020 | **Decidido:** fuera; se empieza en FY2021 |
| 6 | Orden | **Decidido:** spike antes de seguir con EODHD |
| 7 | ¿Una resolución puede corregir la fuente de verdad? | **Abierto:** en esta fase no |
| 8 | Forma de guardar la resolución (8.2 a/b) | **Abierto** |
| 9 | ¿Hace falta GLEIF? | **Abierto:** depende de si EODHD da el LEI fuera de EEUU (spike) |
