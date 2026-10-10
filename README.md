# second-hero-data

Capa de datos de **Second hero**, un screener de acciones para EEUU, Canadá y Europa.

Tubería: `EODHD → normalizador → fuente de verdad → validación → (materializador → vistas)`. Este repo cubre hasta la validación; materializador y vistas vienen después.

| Dónde | Qué |
|---|---|
| `PLAN.md` | Plan de construcción por fases, con criterios de aceptación. |
| `CLAUDE.md` | Contexto y reglas para trabajar en el repo con Claude Code. |
| `docs/modelo/` | Diseño cerrado del modelo de datos (36 tablas). Empezar por `docs/modelo/README.md`. |
| `docs/verificacion-eodhd.md` | Resultado de la verificación en vivo contra EODHD (Fase 1). |
| `docs/registro.md` | Registro de avance y decisiones provisionales. |
| `docs/propuestas-cambio-modelo.md` | Lo que no encaja con el diseño y hay que decidir. |

Stack: Node 22 + TypeScript, Postgres 16 (Docker), tests con vitest contra Postgres real.

Arranque rápido (cuando exista la Fase 0):

```bash
cp .env.example .env   # rellenar EODHD_API_KEY y SEC_USER_AGENT
npm install
npm run db:up && npm run db:migrate
npm test
```
