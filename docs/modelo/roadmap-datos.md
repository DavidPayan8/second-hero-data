# ROADMAP DE DATOS (Payán)

Seguimiento de **nuestra parte**: la tubería de datos. El front, deploy e infra de aplicación **no entran aquí** — los lleva el otro equipo. Este roadmap se mantiene vivo: marcamos logros y los documentamos a medida que cerramos piezas.

## Alcance: qué es "nuestro"

```
proveedor (EODHD)
  → NORMALIZADOR    ← descarga, parseo, resolución de identidad, payload crudo
  → FUENTE DE NUESTRA VERDAD    ← tablas inmutables, dato en forma/divisa nativa
  → MATERIALIZADOR    ← cruza niveles, deriva ratios/técnicos, winsoriza, rankea
  → VISTAS    ← screener_snapshot + series ajustadas (lo que consulta el front)
  ───────────────────────────────────────────────
  → front / deploy / app    ← NO es nuestro
```

**Glosario de fases** (para que todos leamos igual):

| Fase | Qué hace | Nuestra |
|---|---|---|
| **Proveedor** | EODHD. Origen de todo. Segunda fuente de contraste: SEC EDGAR (EEUU). | — (externo) |
| **Normalizador** | Descarga del proveedor, parseo, resolución de identidad (ISIN→security, anclado de holder_ref, sub-exchange del `.US`), guardado del payload crudo. | ✅ sí |
| **Fuente de nuestra verdad** | Tablas inmutables en forma/divisa nativa. Lo que hemos diseñado. | ✅ sí |
| **Validación** | Reglas post-ingesta (cuadre, saltos, divisa, frescura, 2ª fuente). Sumidero único de revisión. | ✅ sí |
| **Materializador** | Construye las vistas: cruza niveles, deriva (EPS, P/E, cap, técnicos), reconcilia divisa, winsoriza y rankea por percentil sectorial. | ✅ sí |
| **Vistas** | Proyección congelada que consulta el front (`screener_snapshot` + series ajustadas). Reconstruible 100% desde la fuente de verdad. | ✅ sí |
| **Front / deploy** | UI, API pública, hosting. | ❌ otro equipo |

---

## Estado por pieza

Leyenda: ✅ cerrado · 🔄 en curso · ⬜ pendiente

### Diseño

#### Fuente de verdad (modelo de datos) — ✅ completa para v1

| Pieza | Estado | Dónde está documentada |
|---|---|---|
| Identidad (COMPANY / SECURITY / LISTING / EXCHANGE / ASSET_TYPE) | ✅ | `modelo-entidades.md` |
| Fundamentales + point-in-time (bitemporal) | ✅ | `decisiones-modelo.md` §2 |
| Precios (bruto) + FX + eventos (splits/dividendos) | ✅ | `decisiones-modelo.md` §5–6 |
| Earnings (calendario de resultados) | ✅ | `decisiones-modelo-earnings.md` |
| Ownership / analistas / short interest | ✅ | `decisiones-modelo-ownership.md` |
| ETFs (perfil / NAV / holdings / allocation) | ✅ | `decisiones-modelo-etf.md` |
| Taxonomía sectorial (SECTOR / INDUSTRY + mapeo) | ✅ | `decisiones-modelo-taxonomia.md` |
| Noticias (subsistema aparte, no fuente de verdad) | ✅ | `modelo-noticias.md` |

#### Normalizador (ingesta) — ✅ completo para v1

| Pieza | Estado | Dónde está documentada |
|---|---|---|
| Payload crudo por ingesta (auditoría/reproceso) | ✅ | `decisiones-modelo-ingesta.md` |
| Mapa código-proveedor↔MIC + sub-exchange `.US` | ✅ | `decisiones-modelo-referencia.md` |
| Resolución de identidad (crosswalk, Opción B CIK/LEI, anclado holder_ref) | ✅ | `decisiones-modelo-identidad.md` |
| Log de correcciones sobre tablas de dimensión (`DIMENSION_AUDIT`) | ✅ | `decisiones-modelo-auditoria.md` |

#### Capa de validación — ✅ completa para v1

| Pieza | Estado | Dónde está documentada |
|---|---|---|
| `DATA_QUALITY_FINDING` + `VALIDATION_RULE` (cuadre, saltos, divisa, frescura, cross-check SEC EDGAR) | ✅ | `decisiones-modelo-validacion.md` |

#### Materializador + Vistas — ⬜ pendiente de diseñar (pieza grande, va la última)

| Pieza | Estado | Nota |
|---|---|---|
| `screener_snapshot` (ratios, técnicos, cap) | ⬜ | Derivados ya catalogados en `modelo-general.md`. |
| Business Score (5 pilares, winsorizar, percentil sector × región) | ⬜ | Taxonomía y validación ya preparadas para él. |
| Series ajustadas materializadas (split / total-return) | ⬜ | Fuente de verdad lista (bruto + eventos). |

### Construcción (implementación)

Repo: `DavidPayan8/second-hero-data`. Plan por fases en `PLAN.md` del repo.

| Fase | Estado |
|---|---|
| 1. Verificación en vivo contra EODHD (★ CIK/LEI primero) | ⬜ |
| 2. Base de datos (migraciones + triggers + seeds, sin VISTAS) | ⬜ |
| 3. Normalizador (captura, referencia, identidad, taxonomía, escritores) | ⬜ |
| 4. Validación (reglas + cross-check SEC EDGAR) | ⬜ |
| 5. Pruebas de ingesta extremo a extremo | ⬜ |

---

## Verificaciones en vivo pendientes contra EODHD

Antes de construir la ingesta de cada bloque, confirmar shape real (no asumido):
- **★ PRIORIDAD 1 (bloqueante): CIK/LEI a nivel de empresa.** Sin esto, todo cae a `identity_source='isolated'` y la doble clase se rompe en la práctica.
- Fecha de presentación en fundamentales (look-ahead bias) — ¿la da EODHD?
- Cobertura de empresas deslistadas (survivorship bias) — ¿qué profundidad?
- Shape de InsiderTransactions (`provider_txn_id`), ownership (`holder_ref`), dirección de `rating_mean`, bloque ETF_Data, sección Earnings, sección News.

---

## Registro de logros

| Fecha | Logro |
|---|---|
| 2026-10 | Fuente de verdad v1 completa: 8 dominios cerrados, 22 tablas, principios transversales fijados. |
| 2026-10 | Incorporada la investigación de datos: segunda fuente (SEC EDGAR), reglas de validación, requisitos del Business Score. |
| 2026-10 | Normalizador v1 completo: payload crudo, referencia proveedor↔MIC, identidad (crosswalk + Opción B), log de correcciones (`DIMENSION_AUDIT`). |
| 2026-10 | Taxonomía canónica (Opción C) y capa de validación cerradas. Todo lo previo a VISTAS diseñado: 36 tablas, 4 capas. |
| 2026-10 | Arranca la construcción: repo `second-hero-data` con plan por fases para ejecutar desde Claude de terminal. |

*(Se añaden filas a medida que cerramos piezas.)*
