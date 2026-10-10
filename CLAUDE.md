# Second hero — capa de datos

Screener de acciones (EEUU, Canadá, Europa) que compite con ScreenerHero. Este repo es **solo la tubería de datos**:

```
EODHD (proveedor) → NORMALIZADOR → FUENTE DE VERDAD → [validación] → MATERIALIZADOR → VISTAS → front (otro equipo)
                    └──────────── este repo, ahora ────────────┘      └─ NO tocar todavía ─┘
```

El diseño del modelo está **cerrado y documentado** en `docs/modelo/`. Aquí se implementa. El plan de trabajo, por fases y con criterios de aceptación, está en `PLAN.md`.

## Antes de escribir código

1. Lee `docs/modelo/README.md` (índice) y `docs/modelo/modelo-general.md` (mapa de las 36 tablas).
2. Para cada pieza que implementes, lee su par `decisiones-modelo-*.md` + `modelo-entidades-*.md`. **Los `decisiones-*` son la fuente canónica**: si un diagrama y una decisión discrepan, manda la decisión.
3. Lee la fase de `PLAN.md` que vas a ejecutar entera antes de empezar.

## Reglas duras

- **No construir VISTAS, materializador ni Business Score.** Nada de `screener_snapshot`, ratios derivados, series ajustadas ni ranking. Van al final y aún no están diseñados.
- **No cambiar el modelo por tu cuenta.** Si al implementar algo no encaja con los docs (un campo que EODHD no da, una restricción imposible, un hueco), **no adaptes el esquema en silencio**: escríbelo en `docs/propuestas-cambio-modelo.md` (qué, por qué, opciones) y pregunta a David. El diseño se decide en la conversación de diseño, no en el código.
- **No inventar datos ni shapes.** La forma de cada respuesta de EODHD se toma de payloads reales capturados, nunca de memoria. Si un dato falta, se registra como ausente (NULL + procedencia explícita o finding), no se rellena.
- **No guardar lo derivable.** Principio rector del modelo: si se puede calcular sin ambigüedad desde otros datos, no se almacena (va a VISTAS).
- **Plugin/MCP de EODHD: para explorar, no para ingerir.** Si está instalado, úsalo para orientarte en la Fase 1. Pero la evidencia de `docs/verificacion-eodhd.md` sale de los payloads crudos capturados, y el normalizador llama a la API REST directamente con `fetch`: necesita el cuerpo HTTP exacto (hash → `PAYLOAD_BLOB`) y corre sin Claude. Lo que devuelve una herramienta MCP puede venir reformateado o recortado.
- **Nunca subir al repo** la API key (`.env`) ni payloads crudos del proveedor (`fixtures/`, datos licenciados). Ambos están en `.gitignore`.
- **Decisiones abiertas marcadas en `PLAN.md`** se implementan con su valor provisional, aislado en un único sitio fácil de cambiar, y anotado en `docs/registro.md`. No se tratan como definitivas.

## Stack y convenciones

- Node 22 + TypeScript (`strict`). `npm`. Sin ORM: el modelo usa triggers, tablas bitemporales y dos tablas polimórficas que un ORM pelearía.
- Postgres 16 vía `docker compose`. Driver `pg`. Migraciones = ficheros SQL numerados en `db/migrations/` + un runner mínimo propio.
- Tests con `vitest` **contra Postgres real** (los triggers tienen que probarse de verdad, nada de mocks de BD).
- IDs `bigint generated always as identity`. Dominios cerrados con `TEXT + CHECK` (no `ENUM`). Importes y cantidades `numeric` (nunca float). Fechas-hora `timestamptz`.
- HTTP con `fetch` nativo. Configuración por `.env` (ver `.env.example`).

## Cómo trabajar

- Una fase de `PLAN.md` cada vez, en orden. Al cerrar una fase: ejecuta sus criterios de aceptación, apunta el resultado en `docs/registro.md` y haz commit.
- Commits pequeños y descriptivos, en español, uno por paso lógico.
- Cuando algo no se pueda verificar (sin datos reales, sin acceso), dilo explícitamente en el registro; no lo des por bueno.
- La **Fase 1 (verificación en vivo)** produce `docs/verificacion-eodhd.md`. Ese documento vuelve a la conversación de diseño: puede cambiar decisiones del modelo, sobre todo la de CIK/LEI.
