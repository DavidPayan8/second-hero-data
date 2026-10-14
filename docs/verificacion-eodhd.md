# Verificación en vivo contra EODHD (Fase 1)

Evidencia de payloads reales capturados en `fixtures/eodhd/` (que no se suben al repo). Una fila por pregunta de `PLAN.md` §1.3.

- **Fecha de captura:** 2026-10-10 (una sola sesión; 35 llamadas reales: las 20 diarias y 15 del bono `extraLimit`).
- **Plan de la API key / endpoints cubiertos:** plan **Free** (`subscriptionType: free`, `dailyRateLimit: 20`, `extraLimit: 500` de bono de bienvenida, de los que quedan 485). Respuesta de `/api/internal-user`. Feeds disponibles: EOD, Search, Exchanges List, News, Sentiment, Live (delayed), dividendos, splits, `sec_filings`, `commodities`, tesoro US. **Sin fundamentals**: `GET fundamentals/AAPL.US` → `403 Only EOD data allowed for free users`. Histórico de precios limitado al último año.
- **Endpoints cuya ruta difiere de la de referencia del plan:** ninguno de los capturados. Las rutas `exchanges-list`, `exchange-symbol-list/{CODE}`, `eod/`, `div/`, `splits/` y `news` respondieron `200`. Rutas no probadas (fuera del plan): `fundamentals`, `calendar/earnings`, `insider-transactions`, `symbol-change-history`. Según la documentación del plugin `eodhd-api` 0.8.0, `fundamentals` tiene también la versión `/api/v1.1/fundamentals/{SYMBOL}` (recomendada), no usada aquí.
- **Coste de cuota observado** (coincide con la doc del plugin): 1 llamada por `eod`, `div`, `splits`, `exchanges-list`, `exchange-symbol-list`; 5 por `news` con un ticker (el bono bajó de 500 a 485 tras 20 llamadas contadas con news a 10; por tanto news = 5) y 0 la petición fallida de `fundamentals`. Según la doc, `fundamentals` cuesta 10 y `symbol-change-history` 5 por ticker.

**Conclusión de la sesión:** con el plan Free solo se pueden contestar C2 (parcial), C4 (parcial), C5, C6 (parcial), C7, C13 y C16 (parcial). **C1, que es la pregunta bloqueante, sigue abierta** y exige un plan con fundamentals. Se para aquí y se avisa a David, tal como pide el plan.

## Resumen

| Id | Pregunta | Veredicto | Impacto en el modelo |
|---|---|---|---|
| ★ C1 | CIK y LEI a nivel de empresa | **Sí en acciones** (3 de 3 con la clave demo); no en ETF | `General.CIK` (cadena de 10 dígitos con ceros: `"0000320193"`) y `General.LEI` en `AAPL.US`, `TSLA.US` y `AMZN.US`. Falta GOOGL/GOOG (doble clase) y Europa/Canadá. Ver «Captura con la clave demo». |
| C2 | ISIN por símbolo | Parcial | En acciones, `General.ISIN`; en ETF, `ETF_Data.ISIN` (no está en `General`). Más `exchange-symbol-list/US`, nulo en el 30 % de los activos. |
| C3 | Fecha de presentación en fundamentales | **Sí** | `Financials.Balance_Sheet.quarterly[fecha].filing_date` (AAPL 2026-06-30 → presentado 2026-07-31) ⇒ `reported_at_source = provider`. Comprobado solo en el balance de AAPL. |
| C4 | Divisa de estados vs. cotización | **Sí** (acciones EEUU y LSE) | `Financials.*.currency_symbol` = `USD` en AAPL; `exchange-symbol-list/LSE` da `Currency` `GBX` para `SHEL`. Divisa de los estados de Shell sin ver. |
| C5 | Sub-bolsa de los símbolos `US` | **Sí** | Campo `Exchange` de `exchange-symbol-list/US`, 17 etiquetas. Entrada para `SOURCE_VENUE_MAP`. |
| C6 | Cobertura de deslistadas | Parcial | Existen y se listan. Profundidad de precios sin medir por el límite de 1 año. |
| C7 | Formato de splits y dividendos | **Sí** | Confirmado. Ver detalle. |
| C8 | Id estable de InsiderTransactions | Sin dato en AAPL | `InsiderTransactions` viene vacío (`{}`) en `AAPL.US` dentro de `fundamentals`. Sigue sin verse un id por transacción. |
| C9 | Id estable de holder (`holder_ref`) | **No** | `Holders.Institutions` y `Funds` (20 entradas cada una en AAPL): `name`, `date`, `totalShares`, `totalAssets`, `currentShares`, `change`, `change_p`; ningún id. |
| C10 | Escala de rating de analistas | **Sí: 5 = Strong Buy** | `AnalystRatings.Rating` de AAPL = 3,7955 y la media ponderada de sus recuentos (19 StrongBuy, 6 Buy, 13 Hold, 3 Sell, 3 StrongSell) con 5 = Strong Buy da 3,7955; con 1 = Strong Buy daría 2,2045. **El modelo asumía lo contrario.** |
| C11 | Bloque ETF | **Sí (VTI)** | `ETF_Data` con perfil, `Holdings` por símbolo (3.468), `Sector_Weights`, `Asset_Allocation`, `World_Regions`, `Market_Capitalisation`. Sin NAV diario ni ISIN del constituyente. |
| C12 | Earnings | Parcial | `Earnings.History[fecha]` con `reportDate`, `beforeAfterMarket`, `epsEstimate`, `epsActual`, `currency` (nulo en el futuro). |
| C13 | News | **Sí** | Etiquetada por lista de símbolos. |
| C14 | `symbol-change-history` | No verificable | Según doc: solo bolsas US, desde 2022-07-22, plan All World Extended o All-In-One. |
| C15 | Etiquetas de sector / industria | Parcial (3 acciones y 1 ETF) | `General.Sector`/`Industry` (estilo Morningstar) y `Gic*` (GICS); el ETF usa otra grafía en `Sector_Weights`. |
| C16 | Valores de `Type` | Parcial | Valores de `exchange-symbol-list`; los de `fundamentals` (`General.Type`) sin ver. |
| C17 | Acciones en circulación | **Sí** | `outstandingShares.quarterly[n]` (`date`, `dateFormatted`, `sharesMln`, `shares`) y `annual`; además `SharesStats.SharesOutstanding`. |

## Captura con la clave demo (2026-10-12): fundamentals de AAPL, TSLA, AMZN y VTI

Cuatro llamadas con la clave pública `demo` de EODHD (no gastan cuota de la clave propia), capturadas con `capture` como cualquier otro payload (`ingestion_run` 176): `fundamentals/AAPL.US` 971.193 bytes, `TSLA.US` 498.091, `AMZN.US` 767.540 y `VTI.US` 687.944, todas HTTP 200. Son payloads reales, no documentación. Secciones de una acción: `General`, `Highlights`, `Valuation`, `SharesStats`, `Technicals`, `SplitsDividends`, `AnalystRatings`, `Holders`, `InsiderTransactions`, `ESGScores`, `outstandingShares`, `Earnings`, `Financials`. Secciones de un ETF: `General`, `Technicals`, `ETF_Data`.

### C1 — CIK y LEI (forma de `General`)

| Símbolo | `General.CIK` | `General.LEI` | `General.ISIN` | `FiscalYearEnd` |
|---|---|---|---|---|
| AAPL.US | `"0000320193"` | `"HWUPKR0MPOU8FGXBT394"` | `"US0378331005"` | `"September"` |
| TSLA.US | `"0001318605"` | `"54930043XZGB27CTOV49"` | `"US88160R1014"` | `"December"` |
| AMZN.US | `"0001018724"` | `"ZXTILKJKG63JELOEG630"` | `"US0231351067"` | `"December"` |
| VTI.US (ETF) | — | — | — (está en `ETF_Data.ISIN`: `"US9229087690"`) | — |

- Claves de `General` en una acción: `Code`, `Type`, `Name`, `Exchange`, `CurrencyCode`, `CurrencyName`, `CurrencySymbol`, `CountryName`, `CountryISO`, `OpenFigi`, `ISIN`, `LEI`, `PrimaryTicker`, `CUSIP`, `CIK`, `EmployerIdNumber`, `FiscalYearEnd`, `IPODate`, `InternationalDomestic`, `Sector`, `Industry`, `GicSector`, `GicGroup`, `GicIndustry`, `GicSubIndustry`, `HomeCategory`, `IsDelisted`, `Description`, `Address`, `AddressData`, `Listings`, `Officers`, `Phone`, `WebURL`, `LogoURL`, `FullTimeEmployees`, `UpdatedAt`. En un ETF solo: `Code`, `Type`, `Name`, `Exchange`, `CurrencyCode`, `CurrencyName`, `CurrencySymbol`, `CountryName`, `CountryISO`, `OpenFigi`, `Description`, `Category` (nulo), `UpdatedAt`.
- **El CIK es una cadena de 10 dígitos con ceros a la izquierda**, no `"320193"` como en el ejemplo de la documentación del plugin. Se guarda tal cual en `COMPANY.cik`; es el mismo formato que pide la API de la SEC (`CIK##########`).
- `FiscalYearEnd` es el nombre del mes en inglés, no un número; `CountryISO` es alfa-2. `IsDelisted` (booleano) existe en `General`.
- **No verificado:** GOOGL/GOOG (¿mismo CIK?), una empresa europea (SAP.XETRA, ITX.MC) ni canadiense: la clave demo solo sirve ciertos símbolos.
- Consecuencia para el normalizador: la ruta `General.CIK` / `General.LEI` es la del `resolver_company()`; un CIK de ceros o vacío se trata como ausente.

### C3 y C4 — fecha de presentación y divisa de los estados

`Financials.Balance_Sheet.quarterly["2026-06-30"]` de AAPL trae `date` `"2026-06-30"`, **`filing_date` `"2026-07-31"`** y `currency_symbol` `"USD"`; `Financials.Balance_Sheet` tiene además `currency_symbol` a nivel de sección. Es la fecha de publicación por periodo que pedía C3: `reported_at_source = 'provider'` es posible. Falta ver `Income_Statement` y `Cash_Flow`, y el campo en periodos anuales.

### C10 — escala del rating (resuelve la duda de P6 a)

`AnalystRatings` de AAPL: `{"Rating": 3.7955, "TargetPrice": 328.0938, "StrongBuy": 19, "Buy": 6, "Hold": 13, "Sell": 3, "StrongSell": 3}` (44 analistas). Media ponderada con 5 = Strong Buy: (5·19 + 4·6 + 3·13 + 2·3 + 1·3) / 44 = **3,7955**, idéntica a `Rating`; con 1 = Strong Buy sale 2,2045. **La dirección es 5 = Strong Buy, 1 = Strong Sell**, como decía la documentación del plugin y al revés de lo que asumía la primera versión del modelo. Solo hay `TargetPrice` (media): sin mínimo ni máximo. Comprobado en AAPL; la regla de validación candidata del modelo (comprobar la dirección con los recuentos) funciona.

### C8, C9, C17 y short interest

- `InsiderTransactions` viene vacío (`{}`) en `AAPL.US`.
- `Holders`: subsecciones `Institutions` y `Funds`, indexadas `"0"`, `"1"`...; cada entrada `{name, date, totalShares, totalAssets, currentShares, change, change_p}` (ej. `BlackRock Inc`, `date` `2026-06-30`, `currentShares` 1.162.996.939). Sin id.
- `outstandingShares.quarterly["0"]` = `{"date": "2026-Q2", "dateFormatted": "2026-06-30", "sharesMln": "14750.3020", "shares": 14750302000}`; también `annual`. `SharesStats.SharesOutstanding` (14.594.180.000) es otra fecha.
- Short interest: `SharesStats.SharesShort` es `null`; `Technicals.SharesShort` 120.763.539 y `SharesShortPriorMonth` 128.753.092, sin fecha de liquidación.

### C12 — earnings

`Earnings` tiene `History`, `Trend` y `Annual`. Una entrada de `History` de AAPL: clave `"2026-09-30"`, `{"reportDate": "2026-11-02", "date": "2026-09-30", "beforeAfterMarket": "AfterMarket", "currency": null, "epsActual": null, "epsEstimate": 1.98, "epsDifference": 0, "surprisePercent": null}`. **`currency` es `null`** aunque haya `epsEstimate`: `EARNINGS.estimate_currency` no sale de ese campo (habría que tomarla de los estados, y el CHECK del esquema la exige si hay estimación). Pendiente de propuesta cuando se escriba el escritor de earnings.

### C15 — sector e industria

| Símbolo | `Sector` | `Industry` | `GicSector` |
|---|---|---|---|
| AAPL.US | `Technology` | `Consumer Electronics` | `Information Technology` |
| TSLA.US | `Consumer Cyclical` | `Auto Manufacturers` | `Consumer Discretionary` |
| AMZN.US | `Consumer Cyclical` | `Internet Retail` | `Consumer Discretionary` |

Hay dos vocabularios en el mismo payload: `Sector`/`Industry` (estilo Morningstar) y `Gic*` (etiquetas tipo GICS). Para D3 hay que decidir con cuál se alimenta `SOURCE_SECTOR_MAP`; el modelo descartó copiar GICS oficial, aunque aquí el proveedor sirve las etiquetas como texto. **El ETF usa otra grafía**: `ETF_Data.Sector_Weights` trae `Basic Materials`, `Consumer Cyclicals` (plural), `Financial Services`, `Real Estate`, `Communication Services`, `Energy`, `Industrials`, `Technology`, `Consumer Defensive`, `Healthcare`, `Utilities`, frente a `Consumer Cyclical` de las acciones. `SOURCE_SECTOR_MAP` necesita las dos grafías.

### C11 — bloque ETF (VTI.US)

- `General` sin ISIN, LEI ni CIK; `Category` `null`. `ETF_Data.ISIN` `"US9229087690"`.
- Perfil: `Company_Name` `"Vanguard"`, `Domicile` `"United States"`, `Index_Name` `null`, `Inception_Date` `"2001-05-24"`, `NetExpenseRatio` **0,0003** (número, en fracción), `Ongoing_Charge` `null`, `Max_Annual_Mgmt_Charge` `"0.00"` (cadena), `Yield` 1,0327 (porcentaje), `TotalAssets` `"704958596680.00"` (cadena), `Holdings_Count` 3468.
- `Holdings`: 3.468 entradas indexadas por símbolo (`"NVDA.US"`), cada una `{Code, Exchange: "US", Name, Sector, Industry, Country, Region, "Assets_%": 6.0681}`. Sin ISIN, importe, acciones ni fecha.
- `Sector_Weights`: 11 etiquetas con `{"Equity_%": número}`. `Asset_Allocation`: `Cash`, `NotClassified`, `Stock non-US`, `Other`, `Stock US`, `Bond`, cada una con `Long_%`, `Short_%` y `Net_Assets_%`, **a veces como número y a veces como cadena `"0"`**. `World_Regions`: 10 claves que mezclan regiones y países (`North America`, `United Kingdom`, `Europe Developed`...) y **suman más de 100** (`North America` 104,0175). `Market_Capitalisation`: `Mega` 41,0366, `Big`, `Medium`, `Small`, `Micro`.
- No hay NAV diario ni acciones del ETF, como sospechaba P7.
- Los valores numéricos mezclan número y cadena dentro del mismo bloque: el escritor de ETF tiene que convertir con cuidado.

## Detalle

### ★ C1 — CIK y LEI a nivel de empresa

Sin payload real: `fundamentals/{SÍMBOLO}` devuelve `403` con el plan Free (`fixtures/eodhd/manifest.json` registra la petición `fundamentals/AAPL.US`; el cuerpo del error no se guarda como fixture). Ningún símbolo de la tabla se pudo comprobar.

| Símbolo | CIK (ruta, valor) | LEI (ruta, valor) |
|---|---|---|
| AAPL.US | no verificado | no verificado |
| GOOGL.US | no verificado | no verificado |
| GOOG.US | no verificado | no verificado |
| KO.US | no verificado | no verificado |
| META.US | no verificado | no verificado |
| JPM.US | no verificado | no verificado |
| O.US | no verificado | no verificado |
| VTI.US | no verificado | no verificado |
| SAP.XETRA | no verificado | no verificado |
| ITX.MC | no verificado | no verificado |
| SHEL.LSE | no verificado | no verificado |
| SHOP.TO | no verificado | no verificado |

¿GOOGL y GOOG comparten CIK?: **sin verificar.**

Pista no verificada: la documentación del plugin `eodhd-api` 0.8.0 (`references/general/fundamentals-common-stock.md`) muestra, para AAPL, `General.CIK = "320193"` (cadena) y `General.LEI`, `General.ISIN`, `General.PrimaryTicker = "AAPL.US"`. Es un ejemplo de la documentación, no una captura; no vale como evidencia. Además, `/api/internal-user` lista el feed `sec_filings` como disponible en el plan Free. No se ha investigado qué endpoint es ni si trae CIK.

Conclusión para `identity_source`: **ninguna todavía.** Hay que capturar `fundamentals` con un plan de pago antes de decidir.

### C2 — ISIN por símbolo

Fuente: `fixtures/eodhd/exchange-symbol-list/US.json` (51.005 símbolos activos) y `US-delisted.json` (60.418). Campo `Isin` (string o `null`).

- Activos: 35.856 de 51.005 tienen `Isin` (70 %).
- El ejemplo de un fondo deslistado (`0P0000V6X4`) trae `Isin: null`.
- No se contó el porcentaje en deslistadas ni se comprobó fuera de EEUU (solo se descargó la lista `US`).

### C3 — Fecha de presentación en fundamentales

No verificable: depende de `fundamentals`.

### C4 — Divisa de estados vs. cotización

- `eod/SHEL.LSE.json`: 253 filas, última `close` 3793,5 el 2026-10-09. La magnitud corresponde a GBX (peniques).
- `div/SHEL.LSE.json`: los dividendos traen `currency: "GBP"` (ej. `value: 0.28915`, fecha 2026-08-13).
- Es decir: **para el mismo símbolo, el precio está en subunidad (GBX) y el dividendo en unidad (GBP).** No hay campo de divisa en las filas de `eod`.
- La divisa de los estados financieros de Shell no se pudo ver.
- **`exchange-symbol-list/LSE` (comprobación de P2, 2026-10-12, 1 llamada, captura en `ingestion_run` 175):** HTTP 200, 1.065.979 bytes, 7.291 símbolos, todos con `Exchange: "LSE"`. **`SHEL` trae `Currency: "GBX"`** (`{"Code":"SHEL","Name":"Shell plc","Country":"UK","Exchange":"LSE","Currency":"GBX","Type":"Common Stock","Isin":"GB00BP6MXD84"}`), de modo que el campo por símbolo sí dice la unidad en la que llega `eod` y P2 no se reabre. Distribución de `Currency` en la lista de Londres: `GBX` 2.504, `USD` 2.295, `EUR` 1.114, `GBP` 942, `SEK` 203, `NOK` 100, `CAD` 49, `DKK` 48, `PLN` 14, `CHF` 12, `JPY` 6, `HKD` 2, `AUD` 1, `HUF` 1. Es decir, la bolsa de Londres no cotiza solo en GBX: hay ETF y valores en USD, EUR y GBP, y por eso `LISTING.quote_currency` tiene que salir de este campo y no de `EXCHANGE.default_currency` (`GBP`). Por `Type` y divisa, los grupos mayores son `ETF`/`USD` 1.382, `Common Stock`/`GBX` 1.358, `ETF`/`GBX` 1.125 y `Common Stock`/`EUR` 927. Limitación: la lista confirma el `Currency` de `SHEL`, pero no demuestra que `eod` llegue en peniques para cada símbolo marcado `GBX`; eso solo se ve con una captura de precios de varios símbolos.

### C5 — Sub-bolsa de los símbolos `US`

Ruta: `exchange-symbol-list/US` → campo `Exchange`. Etiquetas exactas vistas y número de símbolos activos:

| Etiqueta | Nº | Etiqueta | Nº |
|---|---|---|---|
| `NMFQS` | 25.484 | `OTCQX` | 495 |
| `PINK` | 8.693 | `OTCGREY` | 570 |
| `NASDAQ` | 5.477 | `OTCCE` | 468 |
| `NYSE` | 3.419 | `AMEX` | 292 |
| `NYSE ARCA` | 2.501 | `OTCMKTS` | 182 |
| `BATS` | 1.559 | `NYSE MKT` | 35 |
| `OTCQB` | 1.261 | `OTC` | 7 |
| `US` | 556 | `OTCBB` | 5 |
| | | `OTCPK` | 1 |

- 556 símbolos traen `Exchange: "US"` genérico: la sub-bolsa no viene resuelta.
- `AMEX` y `NYSE MKT` conviven (mismo mercado con nombre histórico distinto).
- `exchanges-list` mapea el código `US` a `OperatingMIC: "XNAS, XNYS, OTCM, XCBO"` (lista separada por comas, no un MIC único).
- Falta contrastar con el campo equivalente de `fundamentals` (`General.Exchange`) para `AAPL.US` y `KO.US`.

### C6 — Cobertura de deslistadas

- `exchange-symbol-list/US?delisted=1`: 60.418 símbolos. Por `Type`: 33.173 `Common Stock`, 19.032 `FUND`, 3.523 `Mutual Fund`, 3.030 `ETF`, 1.246 `Preferred Stock`, 235 `Unit`, 87 `Notes`, 81 `Warrant`, 6 `BOND`, 3 `ETC`, 1 `UNIT`, 1 con `Type: null`.
- `eod` de `TWTR.US`, `BBBY_old.US`, `LEH.US` y `CS.US` devolvió `[]` (2 bytes). Causa probable: el plan Free solo da el último año y estas bajas son anteriores. **No es evidencia de que no haya datos**, solo de que no se pueden ver con este plan.
- `div/CS.US`: 26 registros, de 2002-08-09 a 2022-05-09. Los dividendos no están limitados a 1 año. `div/TWTR.US`: vacío.
- Según la doc del plugin (`references/general/delisted-tickers-guide.md`): 26.000+ tickers US desde 2000 y 42.000+ no-US de los últimos 6-7 años. No verificado con payload.
- **Reutilización de ticker, visto en la lista:** `BBBY` (NYSE, ISIN `US6903701018`) y `BBBY_old` (NASDAQ, ISIN `US0758961009`); `BBBYQ` (PINK) comparte ISIN con `BBBY_old`. Mismo patrón con `SHLD_old`/`SHLDQ`. Ver `docs/propuestas-cambio-modelo.md`.

### C7 — Formato de splits y dividendos

Confirmado con datos reales.

- Splits (`splits/AAPL.US`): `{"date": "2020-08-31", "split": "4.000000/1.000000"}`. El formato es `N.000000/M.000000`, **no** `"N/M"`. Historia desde 1987-06-16 (5 splits).
- Dividendos (`div/AAPL.US`, `div/CS.US`, `div/SHEL.LSE`, `div/SAP.XETRA`, `div/ITX.MC`): campos `date`, `declarationDate`, `recordDate`, `paymentDate`, `period`, `value`, `unadjustedValue`, `currency`.
  - `declarationDate` y `recordDate` pueden ser `null` (SHEL, SAP, CS).
  - `period` toma al menos: `Quarterly`, `Annual`, `Interim`, `Final`, `Other`.
  - `value` y `unadjustedValue` difieren en históricos con ajuste (CS 2002: `1.28486` vs `1.3162`).
  - `currency` viene por fila: `USD`, `GBP`, `EUR`.
  - Puede incluir fechas futuras (ITX: `date: 2026-10-29`).
- `div/SHOP.TO`: vacío.
- `period` también viene `null` y con el valor `"Unknown"`: `AAPL.US` 9 de 92 filas `null`; `SHEL.LSE` 58 de 104; `SAP.XETRA` 18 de 32; `ITX.MC` 20 de 47; `CS.US` trae 3 `"Unknown"`. Lista real de valores vistos: `Quarterly`, `Annual`, `Interim`, `Final`, `Other`, `Unknown`, `null`. Importa para la clave `UNIQUE NULLS NOT DISTINCT (security_id, ex_date, period)`.
- **Claves repetidas:** en los 5 valores con dividendos (301 filas) no se repite `date` ni `(date, period)`.
- **¿`date` es la fecha ex?** Comprobado con `div/AAPL.US` (92 filas, todas con `recordDate`): la distancia en días hábiles de `date` a `recordDate` sigue el ciclo de liquidación de EEUU. T+5 (hasta 1995-06-06): 4 días hábiles en 19 de 33 filas y 5 en las otras 14. T+3 (1995-06-07 a 2017-09-04): 2 días en 20 de 23 y 3 en 3. T+2 (2017-09-05 a 2024-05-27): 1 día en 25 de 27 y 2 en 2. T+1 (desde 2024-05-28): 0 días en 8 de 9 y 1 en 1. Ninguna `date` cae en fin de semana. El contador no descuenta festivos. Las desviaciones desde 2017 son tres, todas con `recordDate` en el lunes 11 de noviembre o su observancia (2018-11-12, 2019-11-11, 2024-11-11), compatible con el cierre de la liquidación por festivo, aunque no lo he comprobado contra un calendario de festivos. Conclusión: `date` se comporta como fecha ex, no como fecha de registro. El criterio literal ("un día hábil antes de `recordDate` antes del 28/05/2024") solo se cumple en la era T+2; en eras anteriores la distancia es mayor por el ciclo T+3 y T+5.
- Falta un split de los últimos 12 meses para ver el formato con datos recientes.

### C8 … C12

Sin captura: `insider-transactions`, holders, analistas, bloque ETF y earnings quedan fuera del plan Free (confirmado por la tabla de `references/subscriptions/free.md` del plugin y por el 403 de fundamentals). Pendiente de plan de pago.

Lo que dice la **documentación del plugin `eodhd-api` 0.8.0** (no es evidencia: no hay payload capturado), útil para saber qué buscar:

- **C8, id estable de insider:** el endpoint de Form 4 trae `accession_number` por filing (no por transacción) y `reporting_owner_cik`; el feed plano no trae id de transacción. Ver propuesta P6 (d).
- **C9, id estable de holder:** la sección `Holders` trae `name`, `date`, `totalShares`, `totalAssets`, `currentShares`, `change`, `change_p` y ningún id. Ver P6 (e).
- **C10, escala del rating:** la doc dice 5 = Strong Buy, 1 = Strong Sell, lo contrario de lo que asume el modelo. Ver P6 (a). **Es la contradicción más importante de esta lista.**
- **C11, bloque ETF** (`fundamentals-etf.md`, `ETF_Data`): no documenta NAV diario; `Holdings` viene indexado por símbolo (`AAPL.US`) con `Code`, `Exchange`, `Name`, `Sector`, `Industry`, `Country`, `Region` y `Assets_%`, **sin ISIN del constituyente**, sin importe ni acciones y sin fecha; las allocations (`Sector_Weights`, `World_Regions`, `Asset_Allocation`, `Market_Capitalisation`) llevan los pesos como cadenas; las etiquetas de sector son de estilo Morningstar (`Consumer Cyclicals`, `Financial Services`). Ver P7.
- **C12:** sin lectura hecha de la doc del plugin.

### C13 — News

`news?s=AAPL.US&limit=10` → 10 artículos. Campos: `date`, `title`, `content`, `link`, `symbols`, `tags`, `sentiment`.

- `symbols` es una lista (el primer artículo trae `["AAPL.US", "SAP.US", "WDAY.US"]`). Sí hay etiquetado multi-símbolo.
- `tags` es una lista de etiquetas temáticas en mayúsculas.
- Coste observado: 5 llamadas con un ticker.

### C14 — `symbol-change-history`

No probado: la doc del plugin dice que exige plan All World Extended o All-In-One, cubre solo bolsas US y empieza el 2022-07-22 (así que FB→META de 2022-06-09 podría quedar fuera de rango). Pendiente.

### C15

No verificable (depende de `fundamentals`).

### C16 — Valores de `Type`

Solo de `exchange-symbol-list/US`: `Common Stock`, `ETF`, `FUND`, `Mutual Fund`, `INDEX`, `Unit`, `UNIT`, `Warrant`, `Preferred Stock`, `Notes`, `ETC`, `BOND`.

- `Unit` y `UNIT` conviven con distinta capitalización; una deslistada trae `Type: null`.
- Los valores de `General.Type` en `fundamentals` no se han visto.

### C17

No verificable (depende de `fundamentals`; la doc del plugin menciona `SharesStats.SharesOutstanding`, sin capturar).

## Captura con la clave demo (2026-10-13): bloques de ownership, analistas, earnings y noticias

Los mismos payloads de `fundamentals` de AAPL, TSLA y AMZN (corrida 176) leídos para los escritores de earnings, analistas, holders, insiders y short interest, más `news` de `AAPL.US`, `TSLA.US`, `AMZN.US` y `VTI.US` con la clave demo (corridas 183 y 184, 10 artículos cada una, HTTP 200). Un ETF (`VTI.US`) solo trae `General`, `Technicals` y `ETF_Data`: no tiene `Earnings`, `AnalystRatings`, `Holders`, `InsiderTransactions` ni `SharesStats`. Todo está verificado solo con tres acciones de EEUU; nada se ha visto con una empresa europea o canadiense.

### Pasivo total (`Balance_Sheet.totalLiab`) y deuda (migración 015)

`totalLiab` existe y tiene la misma cobertura que `totalAssets`. Periodos con dato (entradas totales entre paréntesis; las entradas sin datos de los primeros años no cuentan): AAPL 152 trimestres (164) y 41 años; TSLA 75 trimestres y 19 años (20); AMZN 120 trimestres (123) y 30 años. `shortTermDebt` y `longTermDebt` (columnas nuevas `short_term_debt` y `long_term_debt`) tienen menos: AAPL 135 y 81 trimestres, 36 y 16 años; TSLA 70 y 68 trimestres, 19 y 18 años; AMZN 92 y 105 trimestres, 24 y 26 años.

Para `ACCOUNTING_BALANCE` (D4): `totalAssets = totalLiab + totalStockholderEquity` cuadra exactamente en todos los periodos de AAPL y AMZN. En TSLA **no cuadra en 7 de 75 trimestres y 9 de 19 años**: la diferencia es la participación no controladora (coincide con `noncontrollingInterestInConsolidatedEntity` en 3 de los trimestres; en el resto ese campo viene null). La regla necesitará tolerancia o esa partida antes de activarse; sigue desactivada.

### Earnings (`Earnings.History`, `Trend`, `Annual`)

- `History` viene indexado por el fin de periodo (`date`, igual que la clave) y trae `reportDate`, `beforeAfterMarket` (`AfterMarket`, `BeforeMarket` o null), `currency`, `epsActual`, `epsEstimate`, `epsDifference` y `surprisePercent`. AAPL 132 entradas, TSLA 66, AMZN 118. `reportDate` nunca es anterior a `date`.
- **El `date` casa con el fin de periodo de `Financials` trimestral** (131 de 132 en AAPL, 65 de 66 en TSLA, 117 de 118 en AMZN; la que falta es el trimestre aún sin reportar): el join por periodo no falla por un día.
- **`currency` solo viene en las entradas ya reportadas.** La entrada futura (`epsActual` null) trae `epsEstimate` con `currency` null, en las tres acciones. Ningún otro campo da la divisa de esa estimación: `Trend` no la trae y la divisa de `Financials` o la de cotización serían suposiciones. Limitación sistemática del proveedor: la fila de calendario se escribe, `eps_estimate` y `estimate_currency` quedan NULL y no se emite finding.
- `revenue_estimate` no está en `History`. `Trend` trae `revenueEstimateAvg` por periodo (`0q`, `+1q`, `0y`, `+1y`) pero sin divisa y con otra definición que `epsEstimate` (TSLA 2026-06-30: `Trend.earningsEstimateAvg` 0,5367 frente a `History.epsEstimate` 0,32), así que no se usa: `revenue_estimate` queda NULL.
- `Annual` solo trae `epsActual` por año: no hay nada que guardar.

### `AnalystRatings`, `SharesStats`, `Technicals`

- `AnalystRatings` (AAPL, TSLA, AMZN): `Rating`, `TargetPrice`, `StrongBuy`, `Buy`, `Hold`, `Sell`, `StrongSell`. No trae divisa del precio objetivo (propuesta P17), ni mínimo y máximo, ni número de analistas.
- `SharesStats` trae `SharesOutstanding`, `SharesFloat`, `PercentInsiders`, `PercentInstitutions` y los campos de short interest, **que vienen todos null** (`SharesShort`, `SharesShortPriorMonth`, `ShortRatio`, `ShortPercentOutstanding`). El short interest está en **`Technicals.SharesShort`** y `Technicals.SharesShortPriorMonth` (AAPL 120.763.539 y 128.753.092). Sin fecha de liquidación, como decía la documentación. `General.UpdatedAt` es una fecha (`2026-10-11`).

### Holders e insiders

- `Holders` tiene `Institutions` y `Funds`, cada uno con 20 entradas indexadas `"0".."19"`: `name`, `date`, `totalShares` (% de las acciones), `totalAssets` (% de la cartera del holder), `currentShares`, `change` y `change_p`. **Sin id estable de holder** (confirma P6 e). Cada holder trae su propia fecha: las instituciones comparten una (`2026-06-30`) y los fondos tienen varias (`2026-06-30`, `2026-08-31`, `2026-09-30`). Los 20 nombres de cada bloque son distintos también tras normalizar.
- `InsiderTransactions`: `{}` en AAPL; 20 transacciones en TSLA y 20 en AMZN con `date`, `ownerCik` (siempre null), `ownerName`, `transactionDate`, `transactionCode` (`P`, `S`), `transactionAmount`, `transactionPrice`, `transactionAcquiredDisposed` (`A`/`D`), `postTransactionAmount` (siempre null) y `secLink`. **Sin id de transacción**: `secLink` es por filing y a veces null. **24 de las 40 transacciones traen `transactionAmount` null** (y `secLink` null): sin cantidad no se pueden crear (`shares_transacted` NOT NULL). `transactionAmount` no lleva signo y el sentido va aparte (propuesta P18).

### Noticias (`news`)

Lista de 10 artículos con `date` (ISO con zona), `title`, `content`, `link`, `symbols`, `tags` y `sentiment {polarity, neg, neu, pos}` (números); sin `summary` ni `publisher`, como decía P8. Ninguno de los 40 artículos trae `link`, `title` o `date` vacíos. 6 de las 33 urls distintas aparecen en más de un payload (la misma noticia etiquetada con varios símbolos). Con la clave demo responden los cuatro símbolos.

### `ACCOUNTING_BALANCE`: participación no controladora (2026-10-13)

Con `totalAssets - totalLiab - totalStockholderEquity` sobre los payloads de la demo: AAPL y AMZN cuadran en todos los periodos con los tres datos (152 y 41; 120 y 30). TSLA no cuadra en **16 periodos** (7 de 75 trimestres y 9 de 19 años) y el hueco es de signo único (el activo supera a pasivo más patrimonio), como corresponde a una participación no controladora que `totalStockholderEquity` no incluye (`liabilitiesAndStockholdersEquity` es igual al activo y no ayuda). `Balance_Sheet` trae `noncontrollingInterestInConsolidatedEntity` y `temporaryEquityRedeemableNoncontrollingInterests`, pero **la partida no cierra los 16**: cierra exactamente 7 (los trimestres de 2025-06-30, 2025-09-30 y 2025-12-31 y los años 2022 a 2025). En los otros 9 viene null (trimestres 2024-12-31 y 2025-03-31, año 2019) o no coincide con el hueco (trimestres 2026-03-31 y 2026-06-30, donde es mayor; años 2016, 2017, 2018 y 2020, donde es menor). `temporaryEquityRedeemableNoncontrollingInterests` no aporta en ningún periodo. Con la tolerancia de D5 (1 % del activo) la regla fallaría en 0 trimestres y 6 años de TSLA (2016 a 2020, con huecos del 2,8 % al 5,1 %, y 2022, 1,4 %). Conclusión: añadir una columna de participación no controladora **no** haría cuadrar los 16 periodos, por eso no hay propuesta de columna y la regla sigue apagada.

**Hipótesis a comprobar con el plan de pago (decisiones-modelo-validacion.md §7, 2026-10-13).** El hueco de signo único de TSLA podría ser el patrimonio temporal: las participaciones no controladoras rescatables (*redeemable noncontrolling interests*, `temporaryEquityRedeemableNoncontrollingInterests` en `Balance_Sheet`), que se presentan entre el pasivo y el patrimonio y que TSLA tuvo en esos años. En la demo ese campo no aportó en ningún periodo, pero la demo solo trae tres empresas. Con el plan de pago hay que medir, sobre unas cientos de empresas, qué campos del proveedor cierran el balance (`totalAssets - totalLiab - totalStockholderEquity`, con y sin participación no controladora y patrimonio temporal), y entonces fijar la fórmula y si la regla es `error` o `warning`. Hasta entonces `ACCOUNTING_BALANCE` sigue apagada.

### Beneficio neto de TSLA: el proveedor mezcla atribuible y consolidado (2026-10-14)

Contra los `companyfacts` reales de la SEC, el `net_income` de EODHD para TSLA unas veces es el atribuible a la matriz (`NetIncomeLoss`) y otras el consolidado con participación no controladora (`ProfitLoss`). Con la regla de `decisiones-modelo-validacion.md` §7 (solo cuenta el atribuible) quedan **8 periodos de TSLA** donde el valor del proveedor coincide con `ProfitLoss` y no con `NetIncomeLoss`: 6 trimestres (2018-06-30, 2019-03-31, 2019-06-30, 2020-03-31, 2022-03-31 y 2026-03-31) y 2 años (2021 y 2024). Cada uno es un `SECOND_SOURCE_MISMATCH` con `detail.kind = 'consolidated'`. Otros 2 trimestres de TSLA (2024-03-31 y 2024-06-30) no coinciden con ninguna de las dos etiquetas (`kind = 'value'`). El resto de periodos de TSLA con dato en las dos fuentes coincide con el atribuible (15 años y 57 trimestres `cross_checked`).

### Comparación con la presentación original de la SEC (2026-10-14)

La fila bitemporal se compara con la presentación de la SEC cuyo `filed` está más cerca de su `reported_at`. Efecto sobre los 3 findings de AAPL 2008 y 2009: el **FY2008 cuadra** (cerrado por el runner); el **FY2009 anual, el trimestre 2009-06-30 y el Q4 de 2009 siguen sin cuadrar**, y ahora por el motivo contrario: con la presentación original de la SEC el proveedor no coincide (ingresos del FY2009: 42.603 millones del proveedor frente a 36.537 en el 10-K original; beneficio: 8.235 frente a 5.704). Es decir, EODHD guarda para esas filas las cifras reexpresadas aunque el `reported_at` sea el de la fecha original. El Q4 de 2009 (activo) se compara con un 10-Q del 2010-01-25 porque el cierre de ejercicio no tiene 10-Q propio: sigue siendo un falso positivo de formulario. Por la misma razón aparecen 4 filas que antes cuadraban con la presentación más reciente y ahora no: AMZN 2015 (activo, 64.747 frente a 65.444 millones en el 10-K original), AAPL 2009-06-30 (ingresos) y TSLA 2024-03-31 y 2024-06-30 (beneficio). Hay que decidir si el proveedor debe compararse con la reexpresión cuando su fila declara la fecha original; con el plan de pago se podrá medir cuántas filas del universo caen en cada caso.

### Clasificación de los findings del cruce con la SEC: `restated` frente a `value` (2026-10-14, `decisiones-modelo-validacion.md` §7)

Con la clasificación de David (coincide con la presentación original → `cross_checked`; coincide con una posterior del mismo periodo → `kind = 'restated'` con el `filed` y el `accn` de esa presentación; con ninguna → `value`) y con el Q4 tratado aparte (sus ingresos y beneficio no se cruzan; su activo se compara con el 10-K), los **14 findings abiertos** de AAPL, AMZN y TSLA quedan así:

| kind | Filas | Detalle |
|---|---|---|
| `restated` | 5 | AMZN 2015 anual y su Q4 (activo; presentación posterior del 2017-02-10), AAPL 2009-06-30 (ingresos y beneficio; posterior del 2010-07-21), TSLA 2024-03-31 y 2024-06-30 (beneficio; posteriores del 2025-04-23 y 2025-07-24). |
| `value` | 1 | AAPL FY2009 anual: el beneficio coincide con una presentación posterior, pero los ingresos (42.603 M) no coinciden ni con el 10-K original (36.537 M) ni con la reexpresión posterior (42.905 M, a un 0,7 %, fuera del 0,5 %). Al mezclar un `restated` y un `value`, la fila es `value`; cada mismatch conserva el suyo. |
| `consolidated` | 8 | TSLA (beneficio igual al consolidado), sección anterior. |

Efectos del Q4: el Q4 de AAPL 2009 ya no se compara con un 10-Q (su activo cuadra con el 10-K original y la fila queda `cross_checked`) y el Q4 de AMZN 2015 pasa a compararse con el 10-K, de ahí su finding `restated` junto al anual. Las filas `restated` son las que, en un backtest point-in-time, mostrarían una cifra que se publicó después de su `reported_at`: con el plan de pago hay que medir cuántas son en el universo antes de decidir si se corrige `reported_at`.

