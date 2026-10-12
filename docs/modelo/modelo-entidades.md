# Modelo de entidades — Fuente de verdad (núcleo)

Diagrama de la **fuente de verdad** (no incluye la capa de lectura / snapshot, que se diseña aparte).

> **Núcleo.** Entidades base: identidad (COMPANY/SECURITY/LISTING), fundamentales, precios, eventos corporativos, FX. Otros dominios ya cerrados viven en archivos propios bajo los mismos principios: `modelo-entidades-ownership.md` (analistas/ownership/short interest), `modelo-entidades-etf.md` (ETFs), `modelo-noticias.md` (noticias, subsistema aparte). Índice en `README.md`. Pendiente: earnings (eventos corporativos), payload crudo, log de correcciones, capa de lectura.

Convenciones:
- Todo se guarda en **forma nativa e inmutable**. La inmutabilidad aplica a los **valores** financieros (un restatement es una fila nueva por `reported_at`); los **flags de procedencia** (`reported_at_source`, `cross_checked_at`) sí transicionan de estado sobre la fila (`provider → cross_checked`), lo cual es una anotación de validación, no un cambio de dato. Esa transición en tablas de hechos **no** la audita `DIMENSION_AUDIT` (solo dimensiones); su traza temporal la da `cross_checked_at`.
- Lo derivable (EPS, P/E, capitalización, precio ajustado) **no aparece aquí**: se calcula en la capa de lectura.

```mermaid
erDiagram
  COMPANY ||--o{ SECURITY : issues
  COMPANY ||--o{ FUNDAMENTALS : reports
  SECURITY ||--o{ LISTING : "quoted as"
  SECURITY ||--o{ SHARES_OUTSTANDING : "has shares"
  SECURITY ||--o{ STOCK_SPLIT : "subject to"
  SECURITY ||--o{ DIVIDEND : pays
  EXCHANGE ||--o{ LISTING : hosts
  ASSET_TYPE ||--o{ SECURITY : classifies
  LISTING ||--o{ PRICES_DAILY : "raw prices"
  LISTING ||--o{ LISTING_TICKER_CHANGE : renamed

  COMPANY {
    bigint company_id PK
    text legal_name "nullable; nunca el nombre del simbolo ni el ticker"
    text lei UK "nullable"
    text cik UK "nullable"
    text identity_source "NOT NULL cik|lei|isolated; CHECK cik=>cik, lei=>lei, isolated=>ambos NULL"
    text country_iso
    bigint sector_id FK "-> SECTOR (nullable; NULL=no clasificado, fuera del ranking)"
    bigint industry_id FK "-> INDUSTRY (nullable; independiente, FK compuesta (industry_id, sector_id) a INDUSTRY)"
    int fiscal_year_end_month
  }

  SECURITY {
    bigint security_id PK
    bigint company_id FK
    bigint asset_type_id FK
    text isin UK
  }

  LISTING {
    bigint listing_id PK
    bigint security_id FK
    bigint exchange_id FK "nullable: NULL = venue no resuelto (+ VENUE_UNMAPPED), fuera de VISTAS"
    text ticker
    text provider_symbol "ej. AAPL.US ; UNIQUE (crosswalk del camino rapido, v1 un proveedor)"
    text quote_currency "NOT NULL ; divisa nativa del proveedor (ej. GBX); sin ella no se crea"
    bool is_primary_listing "UNIQUE parcial por security"
    text status "NOT NULL, CHECK active|delisted"
    date status_date "nullable (fecha de baja desconocida)"
  }

  EXCHANGE {
    bigint exchange_id PK
    text mic UK "ISO 10383 (XNAS, XNYS, XMAD...) = bolsa real ; NOT NULL"
    text country_iso "NOT NULL, CHECK ^[A-Z]{2}$ (alfa-2)"
    text default_currency "NOT NULL ; descriptiva, NUNCA rellena LISTING.quote_currency"
    text timezone "NOT NULL ; IANA, ej. America/New_York (disparo por cierre)"
    time close_time "NOT NULL ; hora local de cierre (disparo de materializacion)"
  }

  ASSET_TYPE {
    bigint asset_type_id PK
    text code UK
    bool in_screener_scope
    bool requires_company "true=accion (company_id NOT NULL) / false=ETF (NULL). Enforcado por trigger en SECURITY"
  }

  FUNDAMENTALS {
    bigint fundamentals_id PK
    bigint company_id FK
    date period_end "periodo que cubre"
    char period_type "Q | A"
    date reported_at "cuando se conocio (point-in-time)"
    text reported_at_source "provider|provider_derived|estimated|manual|cross_checked"
    timestamptz cross_checked_at "cuando la validacion confirmo contra 2a fuente; NULL si aun no"
    text currency "divisa de reporte (!= quote_currency)"
    numeric revenue
    numeric gross_profit
    numeric ebitda
    numeric operating_income
    numeric net_income
    numeric operating_cf
    numeric capex
    numeric total_debt
    numeric cash
    numeric total_equity
    numeric total_assets
  }

  SHARES_OUTSTANDING {
    bigint id PK
    bigint security_id FK
    date period_end
    date reported_at "point-in-time (consistencia)"
    text reported_at_source "mismo dominio que FUNDAMENTALS"
    numeric shares
  }

  STOCK_SPLIT {
    bigint id PK
    bigint security_id FK
    date ex_date
    numeric split_numerator "4:1 -> 4"
    numeric split_denominator "4:1 -> 1 ; factor = num/den"
  }

  DIVIDEND {
    bigint id PK
    bigint security_id FK
    date ex_date "unica fecha que entra en el ajuste"
    date declaration_date "metadata"
    date record_date "metadata"
    date payment_date "metadata"
    text period
    numeric amount_native "= unadjustedValue (inmutable)"
    text currency "NO opcional"
  }

  PRICES_DAILY {
    bigint listing_id PK "FK"
    date date PK
    numeric open "bruto"
    numeric high "bruto"
    numeric low "bruto"
    numeric close "bruto"
    numeric volume
  }

  LISTING_TICKER_CHANGE {
    bigint id PK
    bigint listing_id FK
    text old_ticker
    text new_ticker
    date effective_date
  }

  FX_RATES {
    text currency PK "ISO-4217 + fraccionarias (GBX)"
    date date PK
    numeric rate_to_base "a EUR"
  }
```

## Notas por entidad

| Entidad | Cuelga de | Rol |
|---|---|---|
| **COMPANY** | — | Negocio. `sector_id`/`industry_id` (FK a taxonomía canónica, ver `modelo-entidades-taxonomia.md`), fiscal year end. |
| **SECURITY** | COMPANY | Clase de acción (ISIN). |
| **LISTING** | SECURITY + EXCHANGE | Cotización (ticker, divisa, primario). |
| **FUNDAMENTALS** | COMPANY | Estados financieros absolutos, por periodo (Q/A). |
| **SHARES_OUTSTANDING** | SECURITY | Acciones por periodo (para per-share correcto). |
| **STOCK_SPLIT** | SECURITY | Splits (`split_numerator`/`split_denominator` nativos). Base del ajuste. |
| **DIVIDEND** | SECURITY | Dividendos (`amount_native` = unadjustedValue). Base del total-return. |
| **PRICES_DAILY** | LISTING | Solo OHLCV **bruto**, divisa nativa. Inmutable. |
| **EXCHANGE** | — | Bolsa real, clave = MIC. No el código de proveedor. `timezone`+`close_time` para el disparo de materialización por cierre (ver chunk de referencia). El mapa código-proveedor↔MIC vive en la capa del normalizador, no aquí. **Dato curado: todas sus columnas NOT NULL; solo se crea desde el seed, nunca desde el normalizador** (`decisiones-modelo-referencia.md` §5). |
| **ASSET_TYPE** | — | Catálogo de tipos. `in_screener_scope` filtra el screener; `requires_company` gobierna si `SECURITY.company_id` debe ser NOT NULL (enforcado por trigger, ver `decisiones-modelo-etf.md` §1). |
| **LISTING_TICKER_CHANGE** | LISTING | Historial de tickers (SEO / no confundir con deslistado). Prescindible en MVP. |
| **FX_RATES** | — | Tipos de cambio a EUR. GBX como fila propia. Forward-fill. |

## Derivados (NO en la fuente de verdad — se calculan en la capa de lectura)

- **EPS** = net_income(COMPANY, TTM) ÷ shares(SECURITY)
- **Capitalización** = close(LISTING primario) × shares(SECURITY) × fx→EUR
- **P/E** = close ÷ EPS *(reconciliar divisa: close en quote_currency, EPS en FUNDAMENTALS.currency)*
- **P/B, P/S, ROE, ROA, márgenes, deuda/equity** = cruces de líneas de FUNDAMENTALS y/o precio *(reconciliar divisa antes de cruzar fundamentales con precio)*
- **Precio ajustado (splits / total return)** = PRICES_DAILY (bruto) × factor(STOCK_SPLIT) [y DIVIDEND para TR]
- **Dividendo ajustado** = DIVIDEND.amount_native × misma cadena de factores de split (invariante 5.4)
- **RSI, SMA, MACD, 52w, volumen medio** = sobre la serie ajustada por splits
