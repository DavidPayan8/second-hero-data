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
| ★ C1 | CIK y LEI a nivel de empresa | **No verificable** con el plan Free | Bloqueante. La doc del plugin dice `General.CIK`, `General.LEI`, `General.ISIN`, `General.PrimaryTicker`, pero no hay payload real. |
| C2 | ISIN por símbolo | Parcial | `exchange-symbol-list/US` trae `Isin`, nulo en el 30 % de los activos. |
| C3 | Fecha de presentación en fundamentales | No verificable | Depende de `fundamentals`. |
| C4 | Divisa de estados vs. cotización | Parcial | `SHEL.LSE` cotiza en GBX (peniques) pero sus dividendos vienen en `GBP`. Divisa de los estados sin ver. |
| C5 | Sub-bolsa de los símbolos `US` | **Sí** | Campo `Exchange` de `exchange-symbol-list/US`, 17 etiquetas. Entrada para `SOURCE_VENUE_MAP`. |
| C6 | Cobertura de deslistadas | Parcial | Existen y se listan. Profundidad de precios sin medir por el límite de 1 año. |
| C7 | Formato de splits y dividendos | **Sí** | Confirmado. Ver detalle. |
| C8 | Id estable de InsiderTransactions | No verificable | Fuera del plan. |
| C9 | Id estable de holder (`holder_ref`) | No verificable | Fuera del plan. |
| C10 | Escala de rating de analistas | No verificable | Fuera del plan. |
| C11 | Bloque ETF | No verificable | Fuera del plan. |
| C12 | Earnings | No verificable | Fuera del plan. |
| C13 | News | **Sí** | Etiquetada por lista de símbolos. |
| C14 | `symbol-change-history` | No verificable | Según doc: solo bolsas US, desde 2022-07-22, plan All World Extended o All-In-One. |
| C15 | Etiquetas de sector / industria | No verificable | Depende de `fundamentals`. |
| C16 | Valores de `Type` | Parcial | Valores de `exchange-symbol-list`; los de `fundamentals` (`General.Type`) sin ver. |
| C17 | Acciones en circulación | No verificable | Depende de `fundamentals`. |

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
- **C11 y C12:** sin lectura hecha de la doc del plugin.

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
