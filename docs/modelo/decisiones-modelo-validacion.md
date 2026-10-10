# Decisiones de diseño — Capa de validación

Última pieza **previa a VISTAS**. Reglas de sanidad y cross-check que producen hallazgos sin bloquear la ingesta ni borrar en silencio. Es también el **sumidero único de todo lo que requiere intervención humana** en el pipeline.

Estado: **cerrado**. Con esto queda cerrado todo lo anterior a la capa de lectura.

---

## 0. El problema

El proveedor se equivoca: balances que no cuadran, saltos imposibles, divisas incoherentes. Necesitamos un sitio donde las reglas dejen **hallazgos** (coherente con "no inventar datos / marcar para revisión, no descartar"). Y ya teníamos **cinco productores de "marcar para revisión"** dispersos (companies `isolated`, re-enlaces contradictorios, holders sin mapear, sectores sin mapear, fallos numéricos) → se unifican.

---

## 1. Sumidero único: `DATA_QUALITY_FINDING` (2ª excepción polimórfica)

Una única tabla para **todo** lo que requiere revisión humana. Polimórfica (`target_table` + `target_row_id`), aceptada como **segunda excepción consciente** por las mismas razones que `DIMENSION_AUDIT`: infraestructura transversal, sin FK entrantes, heterogénea por diseño.

**Por qué única y no cinco tablas:** un operador/panel de administración necesita **una** pantalla/API para "todo lo que requiere intervención", no consultar cinco tablas. Decisión operativa correcta.

**Condición de diseño (evitar el cajón de sastre):** hay que distinguir claramente **incidencias estructurales** (mapeo/identidad) de **incidencias de calidad de dato** (numéricas/contables) para filtrar eficientemente. Resuelto con `rule_code` → `VALIDATION_RULE.category` (`structural` | `data_quality`).

---

## 2. Catálogo de reglas: `VALIDATION_RULE` (comportamiento como dato)

`VALIDATION_RULE (rule_code PK, description, category, default_severity, enabled)`. Catálogo en BD; **la lógica de ejecución vive en el código de la aplicación**, indexada por `rule_code`.

- **Por qué no meter el SQL/código de la regla en BD:** antipatrón de mantenibilidad y seguridad (strings de consulta ejecutables en la BD). 
- **Por qué sí el catálogo en BD:** permite **apagar una regla ruidosa** o **cambiar su severidad** (`warning`→`error`) en producción **al instante, sin desplegar**. Mismo equilibrio que `in_screener_scope`/`requires_company`: se datifica el on/off y la severidad (barato y útil), no la lógica (sobreingeniería).
- Todos los productores emiten con un `rule_code` catalogado, **incluidas las marcas estructurales** (p. ej. `IDENTITY_ISOLATED`, `IDENTITY_RELINK_CONFLICT`, `HOLDER_UNMAPPED`, `SECTOR_UNMAPPED`) junto a las de calidad (`ACCOUNTING_BALANCE`, `YOY_JUMP`, `CURRENCY_COHERENCE`, `SECOND_SOURCE_MISMATCH`, `STALENESS`).

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
