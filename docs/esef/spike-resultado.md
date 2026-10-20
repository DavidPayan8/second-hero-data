# Spike ESEF/UKSEF — resultado

> Ejecutado el 2026-10-19 en la rama `esef-segunda-fuente`. Encargo: `docs/esef/spike.md`. Propuesta de partida: `docs/esef/propuesta.md` (P19), **sin modificar**.
> Código: `spikes/esef/` (TypeScript, `fetch` nativo, ≤1 petición/s, `User-Agent` = `SEC_USER_AGENT`). Payloads en `fixtures/esef/` (no se suben). Registro de peticiones: `fixtures/esef/requests.log`.
> Solo lectura: ninguna escritura en base de datos, ninguna migración, nada en `src/`.

## 1. Resumen

**Plan de EODHD.** `npm run quota` → `subscriptionMode: "free"`, `dailyRateLimit: 20`, y `availableDataFeeds` **no incluye fundamentals**. Por la regla del spike no se llamó a EODHD y `fixtures/eodhd/` no tiene fundamentales ni `General` de ninguna empresa europea (solo `eod` y `div`). Consecuencia: **Q4 (parte EODHD), Q5, Q6 (parte FUNDAMENTALS) y Q7 (parte EODHD) no se han podido verificar**. Todo lo que depende solo de filings.xbrl.org y GLEIF sí está medido.

**Se confirma**
- La API es abierta, sin clave, sin límite visible (ninguna respuesta distinta de 200 en ~70 peticiones) y rápida: 0,1–2 s por informe, ~20 s por página de 1000 filings con `include=entity`.
- El xBRL-JSON trae valores como **texto exacto, completos (sin escalar)**, con `decimals`, sin notación exponencial ni separadores. Encaja con `numeric` y con el redondeo por `decimals` de 7.2.
- El identificador de la entidad es el **LEI**, y el `fxo_id` empieza por él. Camino principal de identidad viable.
- Los conceptos IFRS estándar sin dimensiones cubren casi del todo las columnas de balance y flujo de caja (ver Q3).
- Hay información suficiente para la regla `ESEF_UNMAPPED`: las extensiones son frecuentes en `revenue` y `capex`.

**Cambia o preocupa**
1. **Alemania no existe en la API**: 0 filings de `DE` (ni SAP, ni Siemens, ni Allianz, ni ningún otro alemán). La muestra queda en 16 de 19 empresas. Alemania queda «no validable» (motivo nuevo: *país no cubierto por la fuente*).
2. **`period_end` del índice no es fiable**: Unilever indexa FY2024 con `period_end = 2025-02-13`; hay 5 informes de fuera de 2026 (`2031-01-01`, `2032-12-31`…) y 4172 en el máximo del índice completo. El cierre real hay que sacarlo de los hechos, no del índice.
3. **El índice mezcla informes anuales con intermedios** (Novo Nordisk tiene 23 informes con cierres trimestrales). Hay que filtrar por duración del periodo principal (~1 año), no por fecha.
4. **Duplicados masivos**: 1732 grupos `(LEI, period_end)` con más de un informe. Solo 80 comparten `sha256`. No vale deduplicar solo por hash (la propuesta 7.1 lo dice): vale por `(LEI, period_end)` + elegir versión.
5. **`total_liabilities` falta en ~43 % de los informes** (los emisores no etiquetan `Liabilities`; es derivable). `capex` estándar solo en 50 %.
6. **Bancos**: no usan `Revenue` ni, en general, `GrossProfit`/`ProfitLossFromOperatingActivities` con significado comparable.
7. **Moneda del informe ≠ moneda de cotización** en varios casos (Unilever informa en EUR; TotalEnergies en USD; Shell, BP, AstraZeneca, HSBC en USD).

**Recomendaciones**
- Guardar en `esef_fact` solo hechos numéricos sin dimensiones de un conjunto de conceptos acotado (≈ 0,3 M filas) en vez de todos (≈ 5 M). Ver sección 5.
- No hace falta GLEIF si EODHD da `General.LEI` en Europa (no verificado); GLEIF funciona y devuelve ISIN, pero con ruido (ver Q4). Decidir tras una captura de `General` europeo con un plan que lo permita.
- Antes de cerrar el esquema, **repetir Q4–Q7 con acceso a fundamentals** (plan de pago o la captura que David pueda hacer).

## 2. Q1 — Cobertura de la API

Índice completo descargado: **26 043 filings, 7 137 entidades**, 27 páginas de 1000 (`fixtures/esef/filings/`, 2026-10-19). Ucrania (9 873) no es ESEF y se ignora.

**Paginación y límites.** `page[size]` acepta al menos 5000 (probado 100/500/1000/5000, todas HTTP 200 con el número de filas pedido). Con `include=entity` y 1000 por página: ~20 s y ~1,3 MB por página; sin `include`, 5000 filas en ~1 s. Sin cabeceras ni errores de límite de uso. `meta.count` da el total. Informes sueltos: 0,1–2,2 s, hasta 42 MB descomprimidos (Iberdrola 2024).

**Atributos reales de `filing`:** `date_added`, `fxo_id`, `inconsistency_count`, `period_end`, `country`, `report_url`, `error_count`, `warning_count`, `package_url`, `viewer_url`, `json_url`, `sha256`, `processed`. Relaciones: `entity`, `validation_messages`. **`entity`:** solo `identifier` (el LEI en ESEF; un id local en Ucrania) y `name`. **No hay** campo LEI aparte, ni idioma, ni versión, ni marca de anual/intermedio.
Nulos: `report_url`/`viewer_url` 246, `json_url` 275, `package_url` 9 873 (todos UA). Sin Ucrania, 275 filings sin `json_url`. `error_count > 0` en 888 de los no ucranianos.
`fxo_id` = `<LEI>-<period_end>-ESEF-<país>-<n>`; `n` es la versión dentro del mismo país.

**Informes por país y año de `period_end`** (cierres de enero cuentan en el año natural del cierre; sin UA). FY = año del cierre salvo ejercicios que cierran en enero (Inditex: cierre 2022-01-31 es su ejercicio 2021).

| País | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | Total |
|---|---|---|---|---|---|---|---|
| AT | 89 | 110 | 102 | 99 | 102 | 91 | 601 |
| BE | 21 | 205 | 145 | 142 | 135 | 58 | 709 |
| DK | 44 | 228 | 399 | 458 | 448 | 491 | 2216 |
| **DE** | **0** | **0** | **0** | **0** | **0** | **0** | **0** |
| ES | 52 | 127 | 124 | 125 | 113 | **1** | 542 |
| FI | 133 | 232 | 227 | 195 | 214 | 166 | 1170 |
| FR | 68 | 228 | 241 | 218 | 225 | 184 | 1179 |
| **GB** | 30 | 341 | 659 | 643 | 590 | 551 | 2966 |
| IT | 0 | 189 | 187 | 170 | 199 | 125 | 875 |
| NL | 18 | 132 | 135 | 126 | 130 | 113 | 657 |
| SE | 0 | 347 | 352 | 360 | 355 | **0** | 1415 |
| NO | 0 | 245 | 251 | 238 | 222 | 2 | 958 |
| PT | 6 | 53 | 55 | 7 | 7 | 0 | 128 |
| PL | 134 | 271 | 304 | 161 | 6 | 0 | 877 |

(Resto de países en `fixtures/esef/q1-out.txt`.) Los recuentos incluyen duplicados e intermedios, así que **no son empresas**: el número de empresas con informe anual es menor. FY2025 está a medio llenar (ES, SE, NO casi vacíos) o depende de cuándo se cierra el ejercicio: es un retraso de incorporación, no de obligación.

**Duplicados** (sin UA): 1732 grupos `(LEI, period_end)` con >1 informe: 206 en varios países (mismo informe presentado en varios OAM, p. ej. Santander ES+GB, Shell GB+NL, AstraZeneca GB+SE), 1570 con varias versiones del mismo país (`-0`, `-1`, `-2`; p. ej. BE, FI). De los grupos solo 80 comparten `sha256`; 1652 difieren (correcciones, idiomas o paquetes distintos). **Campo que los une: `(entity.identifier, period_end)`**, no el hash. Cuál es la versión buena no lo dice el índice: se puede usar menor `error_count` y mayor `processed`.

## 3. Q2 — Forma del xBRL-JSON

32 informes de la muestra (16 empresas × primero y último ejercicio desde 2021: 15 con cierre en 2021 y 17 posteriores), 260,9 MB descomprimidos (medido en `docs/esef/medicion-compresion.md`; la cifra de ~590 MB que figuraba aquí era errónea) (`fixtures/esef/json/`, `fixtures/esef/q23.json`).

- **Estructura:** `documentInfo` (tipo `https://xbrl.org/2021/xbrl-json`, `namespaces`, `taxonomy`, `features.xbrl:canonicalValues`) y `facts`: objeto `{ "f-1": { value, decimals, dimensions } }`. `dimensions` contiene `concept` (QName con prefijo `ifrs-full:` o el de la empresa), `entity` (`scheme:<LEI>`), `period` y, solo en numéricos, `unit`. Cualquier otra clave es una dimensión de taxonomía (`ifrs-full:ComponentsOfEquityAxis` 8 719 veces, `SegmentConsolidationItemsAxis` 1 005, `RetrospectiveApplicationAndRetrospectiveRestatementAxis` 442, `ConsolidatedAndSeparateFinancialStatementsAxis` 384…).
- **Periodo:** `inicio/fin` ISO con hora; el fin y los instantes vienen como **las 00:00 del día siguiente al cierre** (`2024-02-01T00:00:00/2025-02-01T00:00:00` = ejercicio cerrado el 2025-01-31). El extractor debe restar un día.
- **Valor:** siempre `string` (27 800 numéricos medidos: 18 721 sin signo, 3 771 con `-`, 0 con exponente, 0 con coma); 150 son `null` (hechos nil). **Completo, no escalado** (`38632000000.0` + `decimals: -6`). 33 numéricos sin `decimals` (todos `null`; p. ej. `ProfitLoss`, `DividendsPaid`). 0 con `decimals: INF`.
- **Unidades:** `iso4217:EUR`, `USD`, `DKK`, `SEK`, `GBP`, y compuestas `iso4217:X/xbrli:shares`; `xbrli:shares` sin moneda.
- **Taxonomía:** IFRS 2019-03-27 hasta 2024-03-27 según el informe; los nombres de concepto de la tabla 6 son estables entre versiones.
- **Hechos por informe (muestra):**

| | Total | Sin dimensiones | Numéricos sin dim. | MB |
|---|---|---|---|---|
| Primer ejercicio (15 informes, cierre en 2021) | 721 de media | 366 | 353 | 0,1–1,2 |
| Posteriores (17 informes) | 843 | 511 | 377 | 3,8–42 |
| Máximo | 1 952 (Santander) | 857 | 677 | 42,1 (Iberdrola) |

  Los FY2021 son pequeños porque solo etiquetan los estados primarios (sin notas detalladas). Sesgo: la muestra son grandes cotizadas; una pequeña tendrá menos hechos.
- **Estimación de volumen para `esef_fact`:** 13 638 pares `(LEI, period_end)` entre 2021-01 y 2026-06 (9 856 en los 9 países de la muestra y GB). Si se guardan todos los numéricos sin dimensiones (~350–380 por informe): **≈ 5,1 M filas**. Si se guarda solo el conjunto de conceptos de la tabla 6 (≈ 24 hechos por informe: ~12 candidatos × 2 periodos): **≈ 0,3 M filas**. El crudo es mucho mayor (~15 MB de media en los recientes), pero va a `payload_blob`.

## 4. Q3 — Conceptos de la tabla 6

Tabla por informe y columna completa en `fixtures/esef/q23-out.txt` (32 filas; `std` = concepto IFRS estándar sin dimensiones en el periodo principal; `ext:` = extensión de la empresa; `alt:` = otro concepto IFRS estándar más habitual; `—` = no aparece). Resumen por empresa (último ejercicio de la muestra):

| Empresa | revenue | gross_profit | operating_income | net_income | total_assets | total_liab. | total_equity | cash | operating_cf | capex |
|---|---|---|---|---|---|---|---|---|---|---|
| Inditex | std | std | std | std | std | — | std | std | std | std |
| Santander (banco) | alt:RevenueFromInterest | std | — | std | std | std | std | std | std | std |
| Iberdrola | std | std | std | std | std | — | std | std | std | std |
| LVMH | std | std | — | std | std | — | std | std | std | — |
| TotalEnergies | ext:RevenueFromContractsWithCustomersExcludingExciseTax | — | — | std | std | — | std | std | std | ext:PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssets |
| Airbus | std | std | — | std | std | std | std | std | std | — |
| ASML | ext:NetSystemSales (FY2025); std (FY2021) | std | std | alt:ProfitLoss | std | — | std | std | std | std |
| Enel | std | — | std | std | std | std | std | std | std | std |
| Novo Nordisk | std | std | std | alt:ProfitLoss | std | std | std | std | std | std |
| Volvo | std | std | std | std | std | — | std | std | std | alt:PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities |
| Nokia | alt:RevenueFromContractsWithCustomers | std | std | std | std | std | std | std | std | alt:PurchaseOfPropertyPlantAndEquipmentIntangibleAssets… |
| Shell | std | — | — | std | std | std | std | std | std | ext:CashOutflowForTotalCashCapitalExpenditure |
| AstraZeneca | std | std | std | std | std | std | std | std | std | std |
| Unilever | std | — | std | std | std | std | std | std | std | std |
| BP | std | — | std | std | std | std | std | std | std | alt:PurchaseOfPropertyPlantAndEquipmentIntangibleAssets… |
| HSBC (banco) | alt:RevenueFromInterest | — | std | *ext:ProfitLossAttributable…PreferenceEquity* (falso positivo) / alt:ProfitLoss | std | std | std | std | std | std |

Cobertura **estándar** sobre los 28 informes de no bancos (14 empresas × 2; los 4 de bancos aparte; no hay aseguradoras porque Allianz no existe en la fuente):

| Columna | std (no bancos) | Notas |
|---|---|---|
| `total_assets`, `total_equity`, `cash`, `operating_cf` | 28/28 | |
| `net_income` | 24/28 | ASML y Novo etiquetan `ProfitLoss` (con y sin participaciones minoritarias: hay que mirar si coincide con el atribuible) |
| `operating_income` | 21/28 | no es obligatorio |
| `revenue` | 22/28 | extensiones de TotalEnergies y ASML; Nokia y alguno de FY2021 usan `RevenueFromContractsWithCustomers` |
| `gross_profit` | 18/28 | muchas no lo presentan (función por naturaleza) |
| `total_liabilities` | 16/28 | **no se etiqueta en casi la mitad**: derivable (`Assets − Equity`), pero el modelo no guarda lo derivable |
| `capex` | 14/28 | `PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities` es el que menos se usa; hay `alt` y `ext` |

**Bancos (4 informes de Santander y HSBC):** `revenue` no existe (solo ingresos por intereses); `operating_income` y `gross_profit` no son comparables aunque aparezca algún `std` (Santander etiqueta `GrossProfit`; revisar a mano qué significa antes de comparar); `total_liabilities`, `total_assets`, `total_equity`, `cash`, `operating_cf` sí.
**Aseguradoras:** no verificado (sin muestra).

Limitaciones del método: la clasificación `ext` se hace con una heurística de nombre y da falsos positivos (HSBC `net_income`, Santander `operating_income`); está marcado a mano en la tabla. No se ha mirado el visor iXBRL para validar significados.

## 5. Q4 — Identidad

- **EODHD `General.LEI` en Europa/GB: no verificado.** Sin fundamentals no hay payload `General` europeo; `docs/verificacion-eodhd.md` C1 sigue sin Europa (SAP.XETRA e ITX.MC figuran «no verificado»).
- **LEI del informe:** viene en `entity.identifier` y en `scheme:<LEI>` dentro de cada hecho; los 17 `entity` distintos de la muestra coinciden con el `identifier` del índice. De las 7 137 entidades, 3 921 tienen forma de LEI (20 caracteres); el resto son ucranianas.
- **GLEIF (LEI → ISIN), 4 casos** (`https://api.gleif.org/api/v1/lei-records/<LEI>/isins`, HTTP 200 en 0,2–0,5 s; `fixtures/esef/gleif/`):

| Caso | LEI | Resultado GLEIF |
|---|---|---|
| Inditex | 549300TTCXZOGZM2EY83 | 2 ISIN: `ES0148396007`, `ES0SDIV00052` (este último es un derecho de dividendo, no la acción) |
| Volvo | 549300HGV012CNC8JD22 | 3 ISIN: `SE0000115446` y `SE0000115420` (clases A y B) y `US9288541082` |
| Novo Nordisk | 549300DAQ1CVT6CXN342 | **906** ISIN (casi todos `US67010J…`: bonos/notas); la acción no sale en la primera página de 50 |
| Shell | 21380068P1DRHMJ8KU70 | **1 813** ISIN (casi todos `US82266…`: deuda); `NL00150001X5` en la primera página |

  Conclusión: GLEIF funciona, pero devuelve **todos los ISIN del emisor** (deuda incluida), así que un cruce necesita filtrar por tipo de instrumento o por `SECURITY.isin` ya conocido. El cruce contra `General.ISIN` de EODHD **no se ha podido probar** (no hay `General` europeo). Doble clase: Volvo confirma «un LEI, varios ISIN»; Novo A/B no se pudo ver en la primera página.

## 6. Q5 — Comparación de prueba

**No verificado.** No hay fundamentales de EODHD para ninguna empresa de la muestra (plan `free`, sin feed fundamentals; `fixtures/eodhd/` sin ellos), por lo que no se ha calculado ninguna diferencia, distribución ni clasificación. La ventana de 7 días no se ha podido contrastar. Dato útil para el día en que se haga: Inditex cierra el 31 de enero (`period_end` en el índice `2022-01-31` para su ejercicio 2021); Unilever tiene `period_end` erróneo en el índice (ver resumen), así que el emparejamiento por fecha debe usar el cierre de los hechos.

## 7. Q6 — Reino Unido y monedas

- **Moneda del informe (medida):** Shell USD, BP USD, AstraZeneca USD, HSBC USD, TotalEnergies USD (con EUR por acción), **Unilever EUR** (con GBP por acción en el último), Santander EUR, el resto en moneda local. Ninguno informa en GBX; **todos los importes están en la unidad principal**.
- **Moneda de FUNDAMENTALS: no verificado.** Evidencia indirecta de EODHD (otros endpoints): `fixtures/eodhd/eod/SHEL.LSE.json` trae `close` ≈ 2 696 (peniques, GBX) mientras `fixtures/eodhd/div/SHEL.LSE.json` rotula los dividendos como `"currency":"GBP"` (≈ 0,29). O sea, EODHD mezcla GBX (precio) y GBP (dividendo) para el mismo valor; Shell informa en USD (medido arriba), así que la etiqueta GBP del dividendo no coincide con la moneda del informe. No dice nada directo de los estados financieros.
- **¿Hace falta `src/fx/subunits.ts`?** Para comparar el informe (siempre GBP/USD/EUR, nunca GBX) no hay nada que convertir en el lado ESEF. Habrá que mirar la moneda de `FUNDAMENTALS` cuando haya datos; la propuesta ya prevé finding de moneda sin conversión cuando difiere.

## 8. Q7 — Choque con la SEC

- **SAP: no hay informe ESEF en la fuente** (Alemania ausente), así que no se produce choque en la muestra por ese lado.
- **ASML** sí tiene ESEF (5 informes, FY2021–FY2025). Que tenga CIK en `COMPANY`/EODHD **no se ha podido verificar** (sin base de datos levantada, Docker apagado, y sin `General` de EODHD).
- Argumento a favor de `ESEF_MISMATCH` separado: sigue en pie por diseño (una fila de `FUNDAMENTALS` podría recibir findings de ambas fuentes si la empresa tiene CIK y LEI), pero **sin confirmación empírica**.

## 9. Cambios propuestos a `docs/esef/propuesta.md` (no aplicados)

1. **Alcance (§2):** quitar Alemania de la cobertura esperada o marcarla «fuente sin cobertura»; añadir al panel (§9.1) el motivo *país no cubierto*.
2. **`esef_filing` (§8.2):** `fxo_id` (único), `content_hash` (hash del cuerpo descargado), `sha256` del índice (distinto del anterior; ahora solo 80 duplicados lo comparten), `lei`, `country`, `period_end_index` (el del índice, informativo) y **`period_end` real extraído de los hechos**, `period_start`, `processed_at`, `date_added`, `report_url`, `viewer_url`, `json_url`, `error_count`, `warning_count`, `inconsistency_count`, `report_currency`, `ifrs_taxonomy`. Añadir el *versión* (`-n` del `fxo_id`) y un indicador de anual/intermedio calculado.
3. **`esef_fact` (§8.2):** columnas `esef_filing_id`, `concept`, `is_extension`, `period_start`, `period_end` (cierre real, ya restando 1 día), `value` numeric, `decimals`, `unit`, `extractor_version`. **Acotar a hechos numéricos sin dimensiones**, y valorar limitar al conjunto de conceptos candidatos de la tabla 6 + alternativos (≈ 0,3 M filas) frente a todos (≈ 5 M).
4. **Conceptos (§6):**
   - `total_liabilities`: solo en ~57 % de los informes; se compararía sólo cuando existe (finding de ausencia ≠ discrepancia). No se propone derivar.
   - `revenue`: añadir `RevenueFromContractsWithCustomers` como alternativa estándar; bancos quedan fuera (sin `Revenue`).
   - `net_income`: aceptar `ProfitLoss` solo marcado como distinto criterio (ASML, Novo).
   - `capex`: lista de alternativas (`PurchaseOfPropertyPlantAndEquipment…`, `PurchaseOfIntangibleAssets…`) más `esef_concept_map` por empresa; cobertura estándar baja (50 %).
   - `gross_profit` y `operating_income`: cobertura 64–75 %; sin ellos, «no comparable», no discrepancia.
5. **Deduplicación (§7.1):** agrupar por `(LEI, period_end real)`, no por hash; elegir la versión con menor `error_count` y mayor `processed`. Un mismo informe llega por varios países.
6. **Periodo (§7.1):** emparejar con el `period_end` de los hechos, no del índice. Filtrar por duración ~1 año para excluir intermedios.
7. **GLEIF (decisión 9):** sin dato de EODHD no se puede cerrar. Si hace falta, usar GLEIF con filtro de ISIN conocido (`SECURITY.isin`), no «todos los ISIN del LEI».
8. **Tolerancias (§7.3):** no hay distribución real que revisar (Q5 sin datos); mantener las bandas a priori.
9. **Cortesía:** nada que cambiar; la API no mostró límites con ≤1 petición/s.

## 10. Lo que quedó sin verificar

| Qué | Por qué |
|---|---|
| `General.LEI` / `General.ISIN` de EODHD en Europa y GB (Q4) | Plan `free` sin fundamentals (`npm run quota`), 20 peticiones/día, sin fixtures europeos |
| Coincidencia LEI de EODHD vs LEI del informe; cruce GLEIF ↔ `General.ISIN` | Idem |
| Toda la comparación de valores y la clasificación de >2 % (Q5) | Sin fundamentales de EODHD |
| Moneda de `FUNDAMENTALS` de SHEL/HSBC/Unilever (Q6) | Idem; solo hay evidencia indirecta en `eod`/`div` |
| ¿ASML y SAP tienen CIK en `COMPANY`? (Q7) | Sin `General` de EODHD y sin base de datos levantada (Docker apagado) |
| Alemania (SAP, Siemens, Allianz) | No hay filings `DE` en la API; no es un fallo de búsqueda: el país entero está ausente |
| Aseguradoras (Q3) | Allianz no existe en la fuente; sin otra aseguradora en la muestra |
| Significado real de conceptos en el visor iXBRL (p. ej. `GrossProfit` de Santander) | No se abrió el visor; la clasificación `std`/`ext` es automática salvo los falsos positivos marcados a mano |
| Representatividad del volumen | La muestra son grandes cotizadas con informes pesados; empresas pequeñas tendrán menos hechos |
| Frecuencia exacta de informes intermedios en el índice | El índice no distingue anual/intermedio; solo se vio en Novo (23 informes) |
| FY2025 completo | La incorporación es parcial (ES 1, SE 0, NO 2); no se sabe cuándo se completará |
