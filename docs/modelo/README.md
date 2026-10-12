# Stock Screener — modelo de datos

Índice del diseño de base de datos. Historial de versiones vive en la conversación de diseño, no en los nombres de archivo — cada archivo de abajo es el **estado actual**, sin sufijo de versión.

## Fuente de verdad

| Archivo | Cubre |
|---|---|
| `decisiones-modelo.md` + `modelo-entidades.md` | Núcleo: identidad (COMPANY/SECURITY/LISTING), fundamentales, precios, eventos corporativos (splits/dividendos), FX, exchange/MIC. |
| `decisiones-modelo-ownership.md` + `modelo-entidades-ownership.md` | Ownership institucional/insider, consenso de analistas, short interest. |
| `decisiones-modelo-etf.md` + `modelo-entidades-etf.md` | ETFs: perfil, NAV, holdings, allocation. |
| `decisiones-modelo-earnings.md` + `modelo-entidades-earnings.md` | Earnings: calendario de resultados, fecha de reporte, EPS/revenue estimado por periodo. |
| `decisiones-modelo-taxonomia.md` + `modelo-entidades-taxonomia.md` | Taxonomía sectorial canónica propia (Opción C): `SECTOR` + `INDUSTRY` (dos niveles) + `SOURCE_SECTOR_MAP`. Sustituye el texto libre de `COMPANY` por `sector_id`/`industry_id` (nullable, trigger de consistencia). Dependencia dura del Business Score. |

## Normalizador / ingesta (capa anterior a la fuente de verdad)

| Archivo | Cubre |
|---|---|
| `decisiones-modelo-ingesta.md` + `modelo-entidades-ingesta.md` | Payload crudo: `INGESTION_RUN`, `RAW_PAYLOAD`, `PAYLOAD_BLOB`. Desacoplado de la fuente de verdad. |
| `decisiones-modelo-referencia.md` + `modelo-entidades-referencia.md` | Datos de referencia: `SOURCE_EXCHANGE` + `SOURCE_VENUE_MAP` (código-proveedor↔MIC, resolución del agregado `US`). + enriquece `EXCHANGE` con `timezone`/`close_time`. |
| `decisiones-modelo-identidad.md` + `modelo-entidades-identidad.md` | Resolución de identidad: crosswalk (ISIN→security, provider_symbol→listing), agrupamiento por empresa (Opción B: CIK/LEI o `isolated`), anclado de `holder_ref` (`SOURCE_HOLDER_MAP`), cambio de ticker, regla anti re-enlace. + `COMPANY.identity_source`, `UNIQUE(LISTING.provider_symbol)`. |
| `decisiones-modelo-auditoria.md` + `modelo-entidades-auditoria.md` | Log de correcciones de dimensiones: `DIMENSION_AUDIT` (audit-log genérico poblado por trigger). Audita las 5 dimensiones mutables + `SOURCE_*`. SCD2 descartado para v1, documentado como evolución futura. |

> **El normalizador queda completo** con las cuatro piezas: payload crudo + referencia + identidad + auditoría.

## Fuera de la fuente de verdad

| Archivo | Por qué está aparte |
|---|---|
| `modelo-noticias.md` | Feed de contenido: no se valida, no se deriva, no se reconcilia — no cumple la definición de fuente de verdad de este proyecto. |

## Capa de validación (post-ingesta, previa a VISTAS)

| Archivo | Cubre |
|---|---|
| `decisiones-modelo-validacion.md` + `modelo-entidades-validacion.md` | Reglas de sanidad y cross-check. `DATA_QUALITY_FINDING` (sumidero único de los 5 productores de "marcar para revisión") + `VALIDATION_RULE` (catálogo on/off + severidad, lógica en código). No bloquea ingesta; VISTAS filtra `error` y marca `warning` con badge. Puebla `reported_at_source='cross_checked'` al cuadrar la 2ª fuente (SEC EDGAR). |

> **Todo lo previo a VISTAS queda cerrado.** Núcleo + dominios (ownership/ETF/earnings/noticias) + normalizador (ingesta/referencia/identidad/auditoría) + taxonomía + validación. Lo único pendiente de diseño es la capa de lectura (VISTAS).

## Principios transversales (no repetir por chunk)

- **No se almacena lo que se puede derivar sin ambigüedad.** "Primitivo" es relativo al límite del sistema: un agregado de origen que no podemos descomponer (consenso de analistas, `shares_float`) se guarda tal cual.
- **Tres patrones temporales:** bitemporal (hechos que se restatean: `FUNDAMENTALS`), snapshot-temporal (series que cambian sin restatearse y son señal: ownership, short interest, NAV, holdings), hecho-puntual (eventos que ocurren una vez: `DIVIDEND`, `STOCK_SPLIT`, `INSIDER_TRANSACTION`).
- **Divisa explícita siempre que un monto no sea obviamente el de cotización** (`FUNDAMENTALS.currency`, `DIVIDEND.currency`, `ANALYST_CONSENSUS.target_currency`, `ETF_SNAPSHOT.currency`).
- **Comportamiento de tipo como dato, no como código** (`ASSET_TYPE.in_screener_scope`, `ASSET_TYPE.requires_company`): un tipo nuevo se añade con una fila, no con un despliegue.
- **Procedencia explícita cuando una fecha/valor puede ser estimado** (`reported_at_source`): nunca un valor inventado sin marcar como tal.

## Pendiente global (no diseñado todavía)

Consolidado de lo que estaba repetido/disperso en cada chunk:

1. **Capa de lectura (`screener_snapshot` / VISTAS).** Proyección derivada, optimizada para filtrado/orden del screener. Es la pieza grande que falta — todo lo demás es fuente de verdad. **Requisitos ya conocidos (de la investigación de producto, incorporar al diseñarla):**
   - **Business Score = 5 pilares** (Growth, Quality, Financial health, Valuation, Momentum), cada uno 0–100.
   - **Método de ranking:** métricas brutas → winsorizar (percentil 1/99) → percentil **dentro de sector/región** → invertir signo donde toque (valoración/deuda: menos es mejor) → promediar con pesos → re-percentilar. Cobertura mínima por pilar o `N/D` (mismo umbral que `ETF_ALLOCATION`).
   - **Casos especiales que rompen el score:** bancos/aseguradoras (sin EBITDA/deuda/Altman → métricas propias o excluir), REITs (FFO/AFFO), denominadores negativos (usar yields E/P, no P/E), Europa semestral (TTM más viejo + IFRS vs GAAP), multicotización (ya resuelto con `is_primary_listing`), splits (ya resuelto).
   - ~~**Dependencia de diseño: taxonomía sectorial.**~~ ✅ **Cerrada** — ver `decisiones-modelo-taxonomia.md` / `modelo-entidades-taxonomia.md` (Opción C: `SECTOR`+`INDUSTRY` propios + `SOURCE_SECTOR_MAP`; `COMPANY.sector_id`/`industry_id` nullable). El peer group `sector × región` se arma en VISTAS.
   - **Métricas por pilar** (lista de referencia): Growth (CAGR ingresos 3/5a, EPS diluido TTM, FCF, consistencia); Quality (ROIC, ROE, márgenes bruto/operativo nivel+estabilidad, gross profitability Novy-Marx, FCF/net income, accruals); Financial health (deuda neta/EBITDA, cobertura intereses, current ratio, Altman Z salvo bancos, Piotroski F); Valuation (EV/EBIT y earnings yield, P/FCF, EV/Sales, P/E, vs. histórico propio); Momentum (12-1, 6m, fuerza relativa vs índice, distancia a máximo 52s, precio vs SMA 50/200).
2. ~~**Payload crudo por ingesta.**~~ ✅ **Cerrado** — ver `decisiones-modelo-ingesta.md` / `modelo-entidades-ingesta.md` (`INGESTION_RUN` + `RAW_PAYLOAD` + `PAYLOAD_BLOB`). Quedan del normalizador: resolución de identidad, datos de referencia (EXCHANGE/MIC), log de correcciones.
3. ~~**Log de correcciones sobre tablas de dimensión.**~~ ✅ **Cerrado** — ver `decisiones-modelo-auditoria.md` / `modelo-entidades-auditoria.md` (`DIMENSION_AUDIT`, audit-log genérico por trigger; SCD2 descartado para v1 y documentado como futuro). Resuelve el historial de `ETF_PROFILE.expense_ratio`.
4. ~~**Earnings (eventos corporativos).**~~ ✅ **Cerrado** — ver `decisiones-modelo-earnings.md` / `modelo-entidades-earnings.md`.
5. ~~**Capa de validación.**~~ ✅ **Cerrada** — ver `decisiones-modelo-validacion.md` / `modelo-entidades-validacion.md` (`DATA_QUALITY_FINDING` + `VALIDATION_RULE`; sumidero único, no bloqueante, VISTAS como cortafuegos; puebla `cross_checked` vía SEC EDGAR). Reglas acordadas encajadas: cuadre contable (error), salto >200% (warning), coherencia de divisa (error), frescura (staleness), 2ª fuente (SEC EDGAR US / filings.xbrl.org EU / sin API Canadá).
6. ~~**Chunk de trazabilidad/fuentes.**~~ ✅ **Cerrado** — ver `decisiones-modelo-referencia.md` / `modelo-entidades-referencia.md` (`SOURCE_EXCHANGE` + `SOURCE_VENUE_MAP`, resolución del agregado `US`). Queda la *aplicación* de esta resolución dentro de la resolución de identidad del normalizador.

## Verificar en vivo contra EODHD (antes de construir la ingesta de esa tabla)

- **★ PRIORIDAD 1 (bloqueante, condiciona la identidad de TODO el universo): CIK/LEI a nivel de empresa.** El agrupamiento por empresa (doble clase GOOGL/GOOG) depende enteramente de que EODHD dé un identificador oficial de emisor (CIK en `General.CIK`, LEI). Si no los da bien, **todo cae a `identity_source='isolated'`** y la doble clase se rompe en la práctica aunque el modelo la soporte. Es el primer sitio a mirar con la API key, antes que ningún otro. (Ver `decisiones-modelo-identidad.md` §3.)
- Shape de `InsiderTransactions` y existencia de `provider_txn_id`.
- Existencia de id estable de filer (`holder_ref`) en el bloque de ownership.
- Dirección de escala de `rating_mean` (asumido 1=Strong Buy).
- Shape del bloque `ETF_Data` (NAV, holdings, allocations).
- Shape de la sección Earnings (campos, before/after market, estimado por periodo; que `fiscal_period_end` case con el de FUNDAMENTALS).
- ~~Shape del endpoint/sección de noticias.~~ ✅ Verificado: etiqueta por símbolo EODHD crudo; se resuelve por el crosswalk de LISTING (ver `modelo-noticias.md`, P8).
- **Cobertura de deslistadas (survivorship bias):** verificar qué profundidad de empresas que dejaron de cotizar da EODHD. Sin deslistadas, cualquier backtest sale artificialmente bueno. (Modelo ya preparado: `LISTING.status='delisted'` + `LISTING_TICKER_CHANGE`; falta confirmar que el proveedor las sirve.)
- **Fecha de presentación en fundamentales (look-ahead bias):** confirmar que EODHD incluye la fecha real de publicación, no solo el cierre de periodo. (Modelo ya preparado: `FUNDAMENTALS.reported_at`; es lo que puebla ese campo con `reported_at_source='provider'` en vez del fallback `estimated`.)
