# Decisiones de diseño — Earnings (calendario de resultados)

Continúa la fuente de verdad (`decisiones-modelo.md` núcleo). Cierra el tercer tipo de "evento corporativo" acordado desde el inicio junto a splits/dividendos.

Estado: **cerrado** (v1).

---

## 0. Qué es nuevo y qué NO (evitar duplicar)

Earnings **parece** paralela a STOCK_SPLIT/DIVIDEND pero no es una tabla de hechos financieros: es una tabla de **fechas de reporte + estimaciones por periodo**. Antes de modelar, la frontera con lo que ya existe:

- **EPS/revenue "real" (actual)** → **NO se guarda.** Es derivable de FUNDAMENTALS (`net_income ÷ shares`). Guardarlo crearía un segundo EPS que se desincroniza del de FUNDAMENTALS. Principio rector.
- **Fecha de reporte de un earnings pasado** → ya es el `reported_at` de FUNDAMENTALS. No se re-guarda como dato primario; `EARNINGS` guarda la fecha *del evento de calendario*, que es lo que el proveedor entrega en su sección Earnings y que puede diferir/anticiparse al `reported_at` de la línea de fundamentales.
- **EPS/revenue estimado** → **genuinamente nuevo.** Roza ANALYST_CONSENSUS pero es distinto: el consenso es rating + target "a día de hoy"; el estimado de earnings es "qué espera el consenso para *este trimestre concreto que aún no ha reportado*". Ligado a un periodo fiscal.
- **Fecha del próximo earnings** → genuinamente nueva. No cubre ningún periodo publicado → no está en FUNDAMENTALS.
- **Timing before/after market** → nuevo, pequeño.
- **Sorpresa (estimado vs real)** → **derivada** (compara estimado guardado con EPS real derivado). No es columna.

---

## 1. Grano: una fila por `(security_id, periodo fiscal)`

- **Cuelga de SECURITY**, no de COMPANY. Aunque el *evento* de resultados es de la empresa, el EPS estimado es **per-share** y por tanto por clase de acción — misma frontera que el EPS real (absoluto en COMPANY, per-share en SECURITY). Colgar de SECURITY mantiene esa consistencia y evita tener que decidir "qué clase es la relevante" para la estimación.
- Clave: **PK natural `(security_id, fiscal_period_end, period_type)`** — mismo esquema de identificación de periodo que FUNDAMENTALS, para poder casar earnings ↔ fundamentales del mismo trimestre. La clave es limpia (sin string libre) → PK natural directa por la regla 1.b (`decisiones-modelo-ownership.md`), como las otras tres snapshot. Sin `id` sintético.

---

## 2. Patrón temporal: hecho-puntual, solo último estado (v1)

Earnings tiene **dos naturalezas temporales a la vez**:
- La **fecha estimada del próximo earnings** y el **EPS estimado** *cambian* al acercarse el reporte (se confirman, se mueven, los analistas revisan) → eso sería snapshot-temporal.
- La **fecha real**, una vez reportado, es un **hecho puntual** inmutable.

**Decisión (v1): hecho-puntual con solo el último estado.** No se guarda el histórico de revisiones de la estimación. La fila se actualiza en sitio (UPSERT por la clave) hasta que el earnings ocurre y la fecha/EPS real se fijan.

- **Por qué no snapshot-temporal en v1:** el screener muestra "próximo earnings: 29 oct, EPS est 1.98" — necesita el último estado, no la trayectoria. El histórico de *cómo se movió la estimación* es señal avanzada que no justifica el coste en v1.
- **Candidato a snapshot-temporal futuro** (mismo tratamiento que `expense_ratio`): si aparece requisito de "evolución de la estimación / revisiones de analistas", se promueve. Documentado, no construido.
- **Matiz UPSERT vs los demás hechos-puntuales:** DIVIDEND/STOCK_SPLIT son append-only inmutables; EARNINGS se **actualiza en sitio** mientras es futuro (la estimación cambia) y se congela al reportarse. Es "hecho-puntual mutable-hasta-consolidar", no idéntico a split/dividend. Se nombra para no asumir append-only.

---

## 3. Columnas

`EARNINGS(security_id, fiscal_period_end, period_type, report_date, report_time, eps_estimate, revenue_estimate, estimate_currency, is_reported)` — PK natural `(security_id, fiscal_period_end, period_type)`.

- `report_date` — fecha del evento (estimada si futuro, real si ya ocurrió).
- `report_time` — `before_market` | `after_market` | `unknown` (`TEXT + CHECK`, dominio-como-dato).
- `eps_estimate`, `revenue_estimate` — estimación de consenso para ese periodo. Nullable.
- `estimate_currency` — **explícito**, no asumir `quote_currency` (lección `FUNDAMENTALS.currency`). El estimado puede venir en la divisa de reporte.
- `is_reported` — bool; `false` mientras es futuro/estimado, `true` una vez consolidado. Permite al screener separar "próximo" de "histórico" sin comparar fechas contra hoy.

---

## 4. Derivados (NO en la fuente de verdad)

- **EPS/revenue real (actual)** = de FUNDAMENTALS del mismo `(security, periodo)`.
- **Sorpresa (surprise %)** = `(eps_real − eps_estimate) / |eps_estimate|`, cruzando `EARNINGS.eps_estimate` con el EPS real derivado de FUNDAMENTALS.
- **"Próximo earnings"** = fila con `is_reported = false` y `report_date >= today`, la más próxima.

---

## 5. Pendiente / verificar en vivo

- **Shape de la sección Earnings de EODHD** (History/Trend/Annual) contra respuesta real: nombres de campo, si da `before/after market`, si el estimado viene por periodo o agregado.
- **Casar `EARNINGS.report_date` con `FUNDAMENTALS.reported_at`**: confirmar que el `period_end` de earnings usa el mismo criterio de cierre que fundamentales (para que el join por periodo no falle por un día de diferencia).
- **Promoción a snapshot-temporal** del estimado si aparece requisito de revisiones.
