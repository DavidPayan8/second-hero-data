# Decisiones de diseño — Capa de validación

Última pieza **previa a VISTAS**. Reglas de sanidad y cross-check que producen hallazgos sin bloquear la ingesta ni borrar en silencio. Es también el **sumidero único de todo lo que requiere intervención humana** en el pipeline.

Estado: **cerrado**. Con esto queda cerrado todo lo anterior a la capa de lectura.

---

## 0. El problema

El proveedor se equivoca: balances que no cuadran, saltos imposibles, divisas incoherentes. Necesitamos un sitio donde las reglas dejen **hallazgos** (coherente con "no inventar datos / marcar para revisión, no descartar"). Y ya teníamos **cinco productores de "marcar para revisión"** dispersos (companies `isolated`, re-enlaces contradictorios, holders sin mapear, sectores sin mapear, fallos numéricos) → se unifican.

---

## 1. Sumidero único: `DATA_QUALITY_FINDING` (2ª excepción polimórfica)

Una única tabla para **todo** lo que requiere revisión humana. Polimórfica (`target_table` + `target_key`), aceptada como **segunda excepción consciente** por las mismas razones que `DIMENSION_AUDIT`: infraestructura transversal, sin FK entrantes, heterogénea por diseño.

**Por qué única y no cinco tablas:** un operador/panel de administración necesita **una** pantalla/API para "todo lo que requiere intervención", no consultar cinco tablas. Decisión operativa correcta.

**Condición de diseño (evitar el cajón de sastre):** hay que distinguir claramente **incidencias estructurales** (mapeo/identidad) de **incidencias de calidad de dato** (numéricas/contables) para filtrar eficientemente. Resuelto con `rule_code` → `VALIDATION_RULE.category` (`structural` | `data_quality`).

---

## 2. Catálogo de reglas: `VALIDATION_RULE` (comportamiento como dato)

`VALIDATION_RULE (rule_code PK, description, category, default_severity, enabled)`. Catálogo en BD; **la lógica de ejecución vive en el código de la aplicación**, indexada por `rule_code`.

- **Por qué no meter el SQL/código de la regla en BD:** antipatrón de mantenibilidad y seguridad (strings de consulta ejecutables en la BD). 
- **Por qué sí el catálogo en BD:** permite **apagar una regla ruidosa** o **cambiar su severidad** (`warning`→`error`) en producción **al instante, sin desplegar**. Mismo equilibrio que `in_screener_scope`/`requires_company`: se datifica el on/off y la severidad (barato y útil), no la lógica (sobreingeniería).
- Todos los productores emiten con un `rule_code` catalogado, **incluidas las marcas estructurales** (p. ej. `IDENTITY_ISOLATED`, `IDENTITY_RELINK_CONFLICT`, `HOLDER_UNMAPPED`, `SECTOR_UNMAPPED`, `DIVIDEND_SAME_EX_DATE`) junto a las de calidad (`ACCOUNTING_BALANCE`, `YOY_JUMP`, `CURRENCY_COHERENCE`, `SECOND_SOURCE_MISMATCH`, `STALENESS`, `CORPORATE_EVENT_CHANGED`).

---

## 3. No bloquea la ingesta; VISTAS es el cortafuegos (matiz de severidad)

El pase de validación corre **después** de que el normalizador escribe en la fuente de verdad. **Nunca rechaza ni borra** — solo produce findings. El pipeline no se cae ni descarta en silencio.

**El filtrado real ocurre en VISTAS**, y no todos los `error` son iguales:
- **`error`** (p. ej. cuadre contable `Activo ≠ Pasivo + Patrimonio`): se guarda en la fuente de verdad **pero VISTAS lo filtra con rigor** → **jamás** llega al motor de scoring ni al usuario. Condición: `severity='error' AND status='open'`.
- **`warning`** (p. ej. salto interanual >200%): **se incluye** en datos y análisis, con **badge/flag de revisión** en la UI.

VISTAS es el cortafuegos definitivo, consultando `DATA_QUALITY_FINDING` para saber qué excluir y qué marcar.

---

## 4. Ciclo de vida del dato contable: cómo se puebla `cross_checked`

Cierra el enum `reported_at_source` previsto en el núcleo:
- Por defecto, la ingesta entra con **`reported_at_source = 'provider'`**.
- El proceso asíncrono de validación ejecuta la **regla de segunda fuente** (SEC EDGAR XBRL companyfacts para EEUU; `filings.xbrl.org` para Europa, cobertura irregular; Canadá sin API → se queda en `provider`).
  - **Cuadra dentro de tolerancia** → actualiza `reported_at_source` a **`cross_checked`** y sella **`cross_checked_at`** con el timestamp del cruce. (La inmutabilidad de `FUNDAMENTALS` aplica a los valores, no a estos flags de procedencia; esta transición en una tabla de hechos no la audita `DIMENSION_AUDIT`, su traza es `cross_checked_at`.)
  - **No cuadra** → **no** se toca el enum + se genera un `DATA_QUALITY_FINDING` (`SECOND_SOURCE_MISMATCH`, `warning`/`error`) para revisión.

---

## 5. Frescura (no es un finding almacenado)

La antigüedad del último dato ("datos a 30/06/2026") es un **derivado de VISTAS** (`max(reported_at)`, `max(PRICES_DAILY.date)`), no una fila almacenada. Solo si el dato supera un **umbral de antigüedad** configurable se emite un finding `STALENESS`.

---

## 6. Objetivo, unicidad y ciclo de vida del finding (P10/P11, 2026-10-12, migración 013)

**Objetivo: `target_key jsonb NOT NULL`** en lugar de `target_row_id bigint`. La PK de la fila afectada como objeto JSON (`{"listing_id": 7, "date": "2026-10-09"}`), CHECK `jsonb_typeof = 'object'`. Mismo cambio y mismos motivos que `DIMENSION_AUDIT.row_key` (`decisiones-modelo-auditoria.md` §3): con `bigint` no cabían las filas de PK compuesta (`prices_daily`, `fx_rates`, `earnings`, `ownership_snapshot`, `analyst_consensus`, `short_interest`, `etf_snapshot`), y `YOY_JUMP` o `CURRENCY_COHERENCE` apuntan justo ahí. Convenciones en `modelo-entidades-validacion.md`.

**Un solo finding abierto por regla y objetivo.** Índice único parcial `(rule_code, target_table, target_key) WHERE status = 'open'`. El productor inserta con `ON CONFLICT … DO UPDATE SET detail = EXCLUDED.detail`: si ya hay uno abierto, se actualiza su `detail` al estado actual en vez de duplicarlo. `detected_at` conserva la primera detección.
- **Excepción `CORPORATE_EVENT_CHANGED`:** al actualizar, conserva el `old` del finding abierto y pone el `new` actual. Un dividendo corregido dos veces antes de revisarse muestra "original → actual". El valor intermedio se pierde; se acepta.

**Estados.** `open` es el único pendiente y el único que bloquea (cortafuegos de VISTAS: `severity = 'error' AND status = 'open'`). Los otros tres cierran el finding:
- `reviewed`: visto, no hace falta acción (lo normal para `info` y muchos `warning`).
- `accepted`: el dato es correcto pese a la regla (falso positivo o caso legítimo); el dato pasa.
- `dismissed`: ya no aplica (el dato se corrigió o la regla estaba mal).

CHECK: `(status = 'open') = (resolved_at IS NULL)` y `(status = 'open') = (resolved_by IS NULL)`. Un finding cerrado **no se reabre**: si el problema vuelve, es un finding nuevo y el cerrado queda como historia.

**No re-emitir lo ya cerrado.** Sin esto, aceptar un `error` duraría hasta el siguiente pase del runner, que lo volvería a abrir. Regla del runner: **no emite** si ya existe un finding cerrado con la misma `(rule_code, target_table, target_key)` y el **mismo `detail`**. Si los datos cambian, el `detail` cambia y sí se emite. Por eso el `detail` de cada regla tiene que ser **determinista sobre los datos**: los valores evaluados, nunca la fecha del pase ni contadores que crecen solos (en `STALENESS`, la última fecha disponible, no "días de retraso"). No va en el esquema (un `detail` grande no cabe en un índice único); se prueba con tests del runner.

---

## 7. Cierre automático, alcance de `YOY_JUMP` y `ACCOUNTING_BALANCE` (2026-10-13, Fase 4)

**Cierre automático de findings de estado.** Hay dos clases de reglas:
- **De estado**: el runner las evalúa sobre los datos actuales (`STALENESS`, `YOY_JUMP`, `CURRENCY_COHERENCE`, `ACCOUNTING_BALANCE`, `SECOND_SOURCE_MISMATCH`). Si en una **pasada completa** de una regla un objetivo con finding abierto ya no cumple la condición, el runner lo cierra como `dismissed` con `resolved_by = 'runner'` y `resolved_at = now()`. Sin esto, un `error` seguiría bloqueando en VISTAS un dato ya corregido hasta que alguien lo cerrara a mano. Una pasada parcial (`--rules` o subconjunto de objetivos) **no** cierra nada: solo puede cerrar lo que ha evaluado.
- **De evento**: las emite el normalizador por algo que ocurrió (`*_REVISED`, `CORPORATE_EVENT_CHANGED`, `*_SAME_EX_DATE`, identidad, `*_UNMAPPED`, `*_INCOMPLETE`). Solo las cierra una persona: el hecho ocurrió aunque el dato ya esté bien.
- La clase la define que la regla tenga lógica en el runner; no hace falta columna nueva.
- **Re-emisión tras un cierre del runner:** un finding cerrado por el runner **no** bloquea la re-emisión si la condición vuelve a darse con el mismo `detail` (el problema ha vuelto de verdad). Solo un cierre **humano** (`reviewed`/`accepted`/`dismissed` por una persona) suprime la re-emisión del mismo `detail` (§6).

**`YOY_JUMP` solo en periodos recientes.** En los primeros años de AAPL, TSLA y AMZN salen 23 avisos que son crecimiento real desde una base pequeña. Sobre todo el universo serían miles de avisos históricos que nadie va a revisar. La regla se limita a periodos con `period_end` en los **últimos 3 años** (lo que el screener enseña), provisional y en el fichero de tolerancias de D5. Al aplicarlo, los 23 de la base de desarrollo los cierra el propio runner (fuera de alcance = ya no se cumple la condición).

**`ACCOUNTING_BALANCE` sigue apagada hasta calibrarla con el universo.** Con 3 empresas no se puede fijar ni la fórmula ni la severidad. En TSLA el hueco es de un solo signo y la participación no controladora solo explica 7 de 16 periodos. La hipótesis a comprobar es el **patrimonio temporal** (*redeemable noncontrolling interests*, entre el pasivo y el patrimonio, que TSLA tuvo esos años). Con el plan de pago se mide sobre unas cientos de empresas qué campos del proveedor cierran el balance, y entonces se decide la fórmula y si es `error` o `warning`.

**Cruce con la SEC (2026-10-14, con datos reales de AAPL, TSLA y AMZN):**
- **Fecha de cierre con margen de 7 días.** EODHD da el fin de mes y la SEC el cierre real (AAPL cierra el último sábado de septiembre: 2025-09-27 frente a 2025-09-30). Provisional, en la config de D5.
- **Contra qué presentación de la SEC se compara:** la que corresponde a **nuestra fila**, es decir, la de `filed` más cercana a su `reported_at` (la presentación original), **no** la más reciente. Una fila bitemporal es una presentación concreta; la SEC guarda también las cifras reexpresadas en informes posteriores (AAPL 2008-2009), y compararlas con la original da falsos positivos. Que la SEC conozca una reexpresión que el proveedor no trae no es un fallo de esta fila.
- **Beneficio neto: solo cuenta el atribuible a la matriz** (`NetIncomeLoss`). `net_income` alimenta el BPA, que es por acción de la matriz. Si la fila del proveedor coincide con el consolidado (`ProfitLoss`) y no con el atribuible, **no** se marca `cross_checked`: se emite `SECOND_SOURCE_MISMATCH` con `detail.kind = 'consolidated'`. Que el proveedor mezcle las dos definiciones en una misma serie (visto en TSLA) es justo lo que la segunda fuente tiene que sacar a la luz, no esconder. Donde el atribuible y el consolidado coinciden (sin minoritarios), no hay diferencia.

---

## Flujo

```
[ Normalizador / Ingesta ]
        │  (entra reported_at_source='provider')
        ▼
[ Fuente de Verdad ] ──(post-proceso asíncrono)──► [ Validador ]
                                                       │
                          ┌────────────────────────────┴───────────────┐
                          ▼                                             ▼
             ¿Cuadra regla 2ª fuente (SEC)?              ¿Fallo de cuadre / mapeo / salto?
                   (sí) │                                        (sí) │
                        ▼                                             ▼
   FUNDAMENTALS.reported_at_source='cross_checked'      DATA_QUALITY_FINDING (rule_code, severity)
                                                                      │
                                                                      ▼
                                                   VISTAS: excluye (error+open) / badge (warning)
```

## Cambios al núcleo

- Tablas nuevas: `DATA_QUALITY_FINDING`, `VALIDATION_RULE`.
- Ninguno estructural en las tablas existentes. `reported_at_source` ya existía; esta capa es quien lo transiciona de `provider` a `cross_checked`.
- Recomendado auditar `VALIDATION_RULE` con `DIMENSION_AUDIT` (cambiar severidad/enabled es justo lo que querrás tener registrado).

## Pendiente / verificar

- Catálogo inicial de `rule_code` y sus severidades por defecto.
- Tolerancias concretas (cuadre contable, margen de la 2ª fuente, % de salto, umbral de staleness).
- Cadencia del pase asíncrono y de los barridos de serie completa.
- Decidir si `finding_type` se denormaliza a `DATA_QUALITY_FINDING` (escape hatch de rendimiento del panel de revisión) o se mantiene por join a `VALIDATION_RULE.category`.
