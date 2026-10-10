# Modelo de entidades — Capa de validación

Sumidero único de hallazgos + catálogo de reglas. Ver decisiones en `decisiones-modelo-validacion.md`. No bloquea la ingesta; VISTAS filtra por severidad.

```mermaid
erDiagram
  VALIDATION_RULE ||--o{ DATA_QUALITY_FINDING : "clasifica (rule_code)"

  VALIDATION_RULE {
    text rule_code PK "ACCOUNTING_BALANCE, YOY_JUMP, IDENTITY_ISOLATED, SECTOR_UNMAPPED..."
    text description
    text category "structural | data_quality"
    text default_severity "error | warning | info"
    bool enabled "apagar sin desplegar"
  }

  DATA_QUALITY_FINDING {
    bigint finding_id PK
    text rule_code FK "-> VALIDATION_RULE"
    text severity "error|warning|info (copia efectiva al emitir; puede override del default)"
    text target_table "tabla afectada (polimorfico, sin FK)"
    bigint target_row_id "fila afectada"
    text status "open | reviewed | accepted | dismissed"
    jsonb detail "contexto: valores, tolerancia, diff 2a fuente..."
    timestamptz detected_at
    bigint detected_by_run FK "-> INGESTION_RUN (nullable: barridos)"
    timestamptz resolved_at "nullable"
    text resolved_by "nullable"
  }
```

> **Polimórfica a propósito.** `target_table` + `target_row_id` apuntan a cualquier fila de cualquier tabla, sin FK. Segunda excepción consciente al anti-patrón polimórfico (como `DIMENSION_AUDIT`): infra transversal, sin referencias entrantes, heterogénea por diseño.

## Tablas nuevas

| Entidad | PK | Rol |
|---|---|---|
| **VALIDATION_RULE** | `rule_code` | Catálogo (comportamiento como dato): `enabled`, `default_severity`, `category`. Lógica en código. |
| **DATA_QUALITY_FINDING** | `finding_id` | Sumidero único de todo lo que requiere revisión humana (calidad + estructural). |

## Productores que alimentan el sumidero (todos con su `rule_code`)

| rule_code | category | Severidad típica | Origen |
|---|---|---|---|
| `ACCOUNTING_BALANCE` | data_quality | error | Validador (Activo = Pasivo + Patrimonio ± tol.) |
| `CURRENCY_COHERENCE` | data_quality | error | Validador (precio↔fundamentales) |
| `YOY_JUMP` | data_quality | warning | Validador (salto >200% revenue/shares) |
| `SECOND_SOURCE_MISMATCH` | data_quality | warning/error | Regla 2ª fuente (SEC) no cuadra |
| `STALENESS` | data_quality | warning | Umbral de antigüedad superado |
| `IDENTITY_ISOLATED` | structural | warning | Identidad (company sin CIK/LEI) |
| `IDENTITY_RELINK_CONFLICT` | structural | error | Identidad (id contradice enlace) |
| `HOLDER_UNMAPPED` | structural | warning | Ownership (holder sin `holder_ref`) |
| `SECTOR_UNMAPPED` | structural | warning | Taxonomía (label proveedor sin mapeo; aplica a `COMPANY` y a `ETF_ALLOCATION.bucket`) |

## Consumo por VISTAS (cortafuegos)

- **Excluir** del scoring y del usuario: filas con finding `severity='error' AND status='open'`.
- **Badge** de revisión en UI: filas con finding `warning` abierto.
- `cross_checked`: lo puebla la regla de 2ª fuente al cuadrar (no es un finding; es la transición de `reported_at_source`).

## Convenciones de `target`

- Un finding sobre un dato **ausente o viejo** (`STALENESS`) no tiene fila natural: apunta con `target_table='security'`, `target_row_id=security_id` (o la clave de la última entidad evaluada). Convención, no estructura nueva.

## Pendiente / verificar

- Catálogo inicial de `rule_code` + severidades por defecto.
- Tolerancias (cuadre, margen 2ª fuente, % salto, staleness).
- `finding_type` denormalizado vs join a `category` (decisión de rendimiento del panel).
