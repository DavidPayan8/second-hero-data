# Registro de avance

Una entrada por fase o paso relevante: qué se hizo, cómo se comprobó (criterios de aceptación de `PLAN.md`) y qué queda pendiente. Las decisiones provisionales (D1–D6) se anotan aquí cuando se implementan.

| Fecha | Fase / paso | Resultado | Comprobación | Pendiente |
|---|---|---|---|---|
| 2026-10-10 | Preparación del repo | Diseño copiado a `docs/modelo/`, `PLAN.md` y `CLAUDE.md` creados. | — | Empezar Fase 0 y Fase 1. |
| 2026-10-10 | Fase 0 mínima + Fase 1 parcial | Creados `package.json`, `tsconfig.json`, `src/config.ts`, `src/cli.ts`, `src/eodhd/{client,endpoints,capture,user}.ts`. `npm run capture` captura con límite de cuota (dry-run por defecto, `--go` para llamar). 35 llamadas reales con el plan Free. | `npm run typecheck` pasa. Los payloads están en `fixtures/eodhd/` con `manifest.json`. Costes de cuota contrastados con `/api/internal-user` (`apiRequests` coincidió con el conteo). | Sin Postgres, docker, vitest ni migraciones (resto de la Fase 0). C1 y otras 10 preguntas necesitan un plan con fundamentals; Fase 1 **no cerrada**, avisar a David. |
| 2026-10-10 | Fase 0 — Arranque | `docker-compose.yml` (postgres:16, volumen persistente), `src/db/{pool,migrate,migrate-cli,withActor}.ts`, `vitest.config.ts`, `test/smoke.test.ts`, scripts `db:up`, `db:migrate`, `db:reset`, `test`. `db/migrations/` y `db/seeds/` creados vacíos. | `npm run db:up && npm run db:migrate` OK con cero migraciones; `npm run db:reset` OK; `npm test` pasa 3 tests contra Postgres real (versión 16, migrate idempotente, `withActor` fija `app.actor`/`app.reason` solo dentro de la transacción); `npm run typecheck` limpio. | Node local es v20.19, el plan pide 22 (`engines` ya declara >=22; npm no lo hace cumplir). Scripts `replay` y `validate` se crean en sus fases. |

## Decisiones provisionales implementadas

| Id | Dónde vive en el código | Valor provisional | Fecha |
|---|---|---|---|
