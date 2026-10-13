# Informe de ingesta extremo a extremo (parcial)

Fecha: 2026-10-14. Base de desarrollo (`second_hero`) tras el `replay` de lo capturado con la clave `demo` (AAPL, TSLA, AMZN, VTI y EURUSD), las listas de símbolos de LSE y US del plan Free, el cambio de divisas del plan Free y los `companyfacts` de la SEC de AAPL, TSLA y AMZN. Es un informe **parcial**: el plan Free no incluye `fundamentals`, así que el resto del universo del criterio de aceptación de la Fase 5 espera al plan de pago.

## 1. Qué endpoints entran en el plan Free

Según `docs/verificacion-eodhd.md`: el plan Free (20 llamadas al día más el bono `extraLimit`) cubre EOD (solo el último año), dividendos, splits, listas de símbolos por bolsa, noticias y tipos de cambio. **No cubre** `fundamentals` (403 `Only EOD data allowed for free users`), ni por tanto insiders, holders, analistas, bloque ETF ni earnings.

Coste por símbolo (tabla `COST` de `src/eodhd/jobs.ts`):

| Endpoint | Cuota | Plan Free |
|---|---|---|
| `eod/{symbol}` | 1 | Sí, solo el último año |
| `div/{symbol}` | 1 | Sí |
| `splits/{symbol}` | 1 | Sí |
| `news` | 5 | Sí |
| `exchange-symbol-list/{code}` | 1 por bolsa | Sí |
| `fundamentals/{symbol}` | 10 | **No** |

Un símbolo cuesta 3 llamadas con lo que entra en Free (8 con noticias). Con `fundamentals` serían 13 (18 con noticias), pero ese endpoint exige plan de pago. Sin `fundamentals` **no se crea ninguna acción** (`decisiones-modelo-identidad.md` §3), así que gastar cuota Free en KO, GOOGL, GOOG, SHEL, META, JPM u O solo traería precios y dividendos de símbolos que no pueden entrar en la base. No se ha gastado cuota en ninguno.

## 2. Recuentos por tabla

| Tabla | Filas | Tabla | Filas |
|---|---|---|---|
| `ingestion_run` | 11 | `earnings` | 316 |
| `raw_payload` | 34 | `analyst_consensus` | 3 |
| `payload_blob` | 33 | `ownership_snapshot` | 3 |
| `exchange` / `source_exchange` | 24 / 24 | `short_interest` | 3 |
| `source_venue_map` | 14 | `holder_position` | 120 |
| `company` | 3 | `insider_transaction` | 16 |
| `security` | 8.428 (8.425 ETF, 3 acciones) | `news` / `news_security` | 33 / 68 |
| `listing` | 9.306 (8.428 primarios) | `etf_profile` / `etf_snapshot` | 1 / 1 |
| `listing_ticker_change` | 0 | `etf_allocation` | 32 |
| `prices_daily` | 29.424 | `etf_holding` | 3.468 |
| `dividend` | 194 | `fundamentals` | 453 |
| `stock_split` | 12 | `shares_outstanding` | 362 |
| `fx_rates` | 15.130 | `sector` / `industry` | 0 / 0 |
| `data_quality_finding` | 331 | `source_sector_map` / `source_holder_map` | 0 / 0 |

Los precios, fundamentales y demás datos de mercado son solo de AAPL, TSLA, AMZN y VTI (la demo). Los otros 9.302 listings salen de las listas de símbolos (LSE y US) y no tienen precios.

Listings por bolsa: XLON 3.380, ARCX 2.477, BATS 1.522, XNAS 1.196, XNYS 229, OTCM 223, XASE 2 y 277 sin bolsa (su venue de EODHD no está mapeado). Divisa de cotización: USD 7.309, GBX 1.122, GBP 697, EUR 178.

`identity_source` de `company`: `cik` 3 (las tres acciones). No hay compañías `isolated`.

`fx_rates`: USD con histórico desde 1975-01-02 (demo, `EURUSD.FOREX`); CAD, CHF, DKK, GBP, GBX, NOK, PLN y SEK con 314 fechas cada una (2025-10-13 a 2026-10-13, el año que da el plan Free).

Corridas: `symbols:LSE` y `symbols:US` (listas de bolsa), `eod:demo`, `div:demo`, `splits:demo`, `fundamentals:demo`, dos de `news:demo` (una parcial), dos de `eod:fx` (una parcial) y una de la SEC (`companyfacts`, 3 llamadas ok).

## 3. Findings por regla y estado

| Regla | Estado | Filas | Origen / comentario |
|---|---|---|---|
| `VENUE_UNMAPPED` | open | 277 | Listings de la lista US cuyo venue de EODHD no está en `source_venue_map`. Mapeo pendiente de David. |
| `SECTOR_UNMAPPED` | open | 14 | Pares sector / industria de EODHD sin `source_sector_map`. Espera al seed de D3. |
| `IDENTITY_RELINK_CONFLICT` | open | 4 | Símbolos (p. ej. `ISVQF.US`, tipo entrante `Common Stock`) cuyo tipo no coincide con el de la security ya creada (`detail.reason = asset_type`). Es del normalizador y solo lo cierra una persona. |
| `SECOND_SOURCE_MISMATCH` | open | 3 | Filas de AAPL de 2008 y 2009: la SEC da cifras reexpresadas en 10-K posteriores. Ver sección 5. |
| `SECOND_SOURCE_MISMATCH` | dismissed (runner) | 8 | TSLA, beneficio neto: el proveedor daba el consolidado (`ProfitLoss`) y la regla comparaba solo `NetIncomeLoss`. Se cerraron al corregir la comparación (cualquier etiqueta del beneficio vale). |
| `YOY_JUMP` | dismissed (runner) | 23 | Crecimiento real en los primeros años; fuera de los últimos 3 años desde la decisión del 2026-10-13. |
| `FUNDAMENTALS_INCOMPLETE` | dismissed (normalizer) | 2 | Insiders sin cantidad de TSLA y AMZN; ya no generan finding. |

`CURRENCY_COHERENCE` y `STALENESS` dan 0. `ACCOUNTING_BALANCE` y `HOLDER_UNMAPPED` están apagadas.

## 4. Criterios de aceptación de la Fase 5

| Criterio | Estado | Detalle |
|---|---|---|
| `GOOGL.US` y `GOOG.US` → la misma `company_id` si comparten CIK | **Pendiente de plan de pago** | Sin `fundamentals` no hay CIK ni se crea la acción. |
| `AAPL.US` → XNAS | **Cumplido** | `AAPL.US`, `TSLA.US` y `AMZN.US` en XNAS. |
| `KO.US` → XNYS | **Pendiente de plan de pago** | Sin `fundamentals` el normalizador se salta la acción (sin finding) y `KO.US` no tiene security ni listing. La bolsa XNYS sí está cargada (229 listings de ETF). |
| `SHEL.LSE` con `quote_currency = 'GBX'` y filas GBX en `FX_RATES` | **Pendiente de plan de pago** (parte cumplida) | Hay 1.122 listings en GBX de la lista LSE y 314 fechas de GBX en `fx_rates`, pero `SHEL` no tiene acción sin `fundamentals`. |
| `VTI.US` con `company_id` NULL, perfil ETF y allocation por sector con `sector_id` | **Parcial** | Cumplido: `company_id` NULL, perfil, snapshot, 32 filas de allocation y 3.468 holdings (demo), en ARCX. Pendiente: `sector_id` es NULL en las 32 filas porque `SECTOR` está vacío hasta aprobar D3. |
| `META.US`: un único listing con su cambio de ticker | **Pendiente de plan de pago** | `listing_ticker_change` está vacío; sin `fundamentals` no hay acción META y no se ha visto historia de tickers. |
| `JPM.US` y `O.US` en Banking y REITs | **Pendiente de plan de pago y de D3** | Necesitan `fundamentals` y las industrias del seed D3, que no existen. |
| Segunda pasada idempotente | **Cumplido** (sobre lo disponible) | Replay `--all` de la demo dos veces: 0 filas nuevas en la segunda; `validate` dos veces: 0 findings nuevos. |
| `docs/informe-ingesta-e2e.md` | **Parcial** | Este documento. Se rehace con el universo completo cuando haya plan de pago. |

## 5. Segunda fuente (SEC)

Captura real de `companyfacts` de AAPL, TSLA y AMZN (3 llamadas, sin cuota, con el `SEC_USER_AGENT` de `.env`). La forma coincide con la de la documentación: claves `cik`, `entityName` y `facts`; taxonomías `dei` y `us-gaap` (a veces `ecd` y `ffd`); cada magnitud en `units.USD` con `start` (solo periodos), `end`, `val`, `accn`, `fy`, `fp`, `form` y `filed`.

Dos ajustes salidos de los datos reales (`src/sec/facts.ts`, `src/validation/config.ts`):

- **Fecha de cierre con ventana.** EODHD da el fin de mes y la SEC el cierre real de los ejercicios de 52/53 semanas (AAPL cierra el 2025-09-27 y EODHD el 2025-09-30). Con la fecha exacta solo 2 años de AAPL se cruzaban. Se admiten 7 días de diferencia (`secPeriodWindowDays`).
- **Beneficio con dos etiquetas.** TSLA publica `NetIncomeLoss` (atribuible a la matriz) y `ProfitLoss` (consolidado); el proveedor da unas veces uno y otras el otro. La fila cuadra si coincide con cualquiera.

Etiquetas us-gaap observadas: ingresos con `SalesRevenueNet` (AAPL y AMZN hasta 2018), `RevenueFromContractWithCustomerExcludingAssessedTax` (después) y `Revenues` (TSLA, todo el histórico); beneficio con `NetIncomeLoss` en las tres y `ProfitLoss` además en TSLA; activo con `Assets` en las tres.

Resultado de `npm run validate`: 266 filas comparadas; **AAPL queda `cross_checked` en 17 años y 72 trimestres** (AMZN 19 y 73; TSLA 17 y 65). Quedan 3 findings abiertos, todos de AAPL en 2008 y 2009: la SEC da en 10-K posteriores cifras reexpresadas por un cambio contable, y el proveedor conserva las originales (p. ej. activo de 2008: 39.572 millones del proveedor frente a 36.171 de la SEC). Son diferencias reales entre las fuentes, no un error de la regla. En el cierre de 2009 el trimestre Q4 se compara además con el balance comparativo de un 10-Q; es un posible falso positivo de formulario que no se corrige por ahora (afecta a una fila).

## 6. Desviaciones respecto a lo esperado

- La mayor parte de los criterios no se puede comprobar con el plan Free. No es un fallo del normalizador: el diseño (§3 de identidad) no crea acciones sin `fundamentals`.
- Los 277 `VENUE_UNMAPPED` y los 14 `SECTOR_UNMAPPED` son trabajo pendiente de datos de referencia (mapa de venues y seed D3), no de código.
- Nada se ha verificado fuera de EEUU para fundamentales, ni con historia larga de FX.
