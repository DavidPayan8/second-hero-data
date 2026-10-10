# Decisiones de diseño — Log de correcciones de dimensiones (`DIMENSION_AUDIT`)

Cuarta y última pieza del **normalizador**. Registra qué cambió y cuándo en las tablas de dimensión mutables, que no tienen historial propio. Continúa los demás chunks del normalizador.

Estado: **cerrado**. Con esto el normalizador queda completo (payload crudo + referencia + identidad + auditoría).

---

## 0. El problema

`COMPANY`, `SECURITY`, `LISTING`, `EXCHANGE`, `ASSET_TYPE` (y las tablas de referencia `SOURCE_*`) son **dimensiones mutables sin historial**. A diferencia de las tablas de hechos (bitemporales o snapshot-temporal, que conservan el pasado), una corrección aquí no deja rastro: cambiar `COMPANY.sector`, fusionar una company `isolated`, o corregir un MIC mal resuelto **borra el valor anterior sin registro**.

Clientes concretos ya existentes: fusiones de companies `isolated` (chunk identidad), re-enlaces marcados para revisión (chunk identidad), historial de `ETF_PROFILE.expense_ratio` (chunk ETF).

---

## 1. Decisión: audit-log genérico, no SCD2

**`DIMENSION_AUDIT`** — una tabla que registra *qué cambió, cuándo y por qué* en cualquier dimensión, poblada por trigger.

**Se descarta SCD2** (versionado por fila con `valid_from`/`valid_to`/`is_current` en cada dimensión) **para v1**. SCD2 solo se paga si necesitas *consultar* frecuentemente el estado histórico de una dimensión ("reconstruir el screener tal como se veía en 2019"), lo cual **no es requisito de v1** — las tablas de *hechos* ya son point-in-time donde importa. SCD2 multiplicaría la complejidad en cinco tablas y cambiaría cómo todo el sistema las referencia (las FK tendrían que apuntar a la versión vigente).

**SCD2 queda documentado como evolución futura**, exclusiva para el día en que surja la necesidad real de "viajar en el tiempo" a nivel de dimensiones.

---

## 2. Excepción consciente al anti-patrón polimórfico

`DIMENSION_AUDIT` es una tabla polimórfica (`table_name` + `row_id` + `column_name` como texto), justo el anti-patrón que evitamos en todo el modelo (CORPORATE_ACTION, tabla única de venues, etc.).

**Aquí se acepta como excepción consciente**, porque:
- Es **infraestructura transversal**, no dato de dominio.
- **Nadie hace FK contra ella** (el problema real de las polimórficas es que rompen la integridad referencial; aquí no hay referencias entrantes).
- Su naturaleza **es heterogénea por diseño**: audita columnas de cinco tablas distintas.

No es lo mismo que una tabla de dominio polimórfica. La distinción es: dominio = no polimórfico nunca; infra de auditoría sin FKs entrantes = polimórfico aceptable.

---

## 3. Grano y columnas

Grano: **una fila por columna cambiada**. Un `UPDATE` que toca 3 columnas = 3 filas, agrupadas por `change_set_id` (mismo cambio lógico).

`DIMENSION_AUDIT(id, change_set_id, table_name, row_id, column_name, old_value, new_value, op, changed_at, changed_by, reason)`
- `table_name` + `row_id` (bigint, todas las dimensiones tienen PK bigint) + `column_name` → qué cambió.
- `old_value` / `new_value` como texto (heterogéneo por diseño).
- `op`: `insert` | `update` | `delete` | `merge`.
- `change_set_id`: agrupa las columnas cambiadas en una misma operación.
- `changed_at`, `changed_by`, `reason`: contexto. `reason` y `changed_by` son clave para auditar fusiones y re-enlaces.

---

## 4. Mecanismo: trigger + contexto de aplicación

Poblada por **trigger** `AFTER INSERT/UPDATE/DELETE` en las tablas auditadas (captura *todos* los cambios, no depende de que la aplicación se acuerde).

- `changed_by`/`reason` los aporta la aplicación vía variables de sesión (`SET LOCAL app.actor`, `app.reason`) que el trigger lee; NULL cuando no se proporcionan (p. ej. una corrección directa en SQL).
- El trigger escribe una fila por columna que realmente cambió (compara OLD vs NEW).

---

## 5. Qué se audita

- **Sí (v1):** `COMPANY`, `SECURITY`, `LISTING`, `EXCHANGE`, `ASSET_TYPE`, **`ETF_PROFILE`** (es una dimensión mutable y su historial de `expense_ratio` depende de este log; faltaba en la primera versión de esta lista), `SECTOR`, `INDUSTRY`, `VALIDATION_RULE`.
- **Recomendado:** las tablas de referencia `SOURCE_EXCHANGE`, `SOURCE_VENUE_MAP`, `SOURCE_HOLDER_MAP` — también son dimensiones mutables, y corregir un mapeo MIC es justo lo que querrás auditar.
- **No:** las tablas de hechos (bitemporales / snapshot-temporal / append-only) — ya conservan su historial por diseño. Auditarlas sería redundante.

---

## 6. El caso de la fusión (companies `isolated`)

Fusionar dos companies (una `isolated` que resultó ser la misma empresa) es más que un cambio de columna: re-apunta las securities de una a otra y desactiva la sobrante. En el audit-log se registra como:
- Filas `update` de `SECURITY.company_id` (old→new) con `op='merge'` y el mismo `change_set_id`.
- Una fila `delete`/desactivación de la COMPANY sobrante.

La semántica "fusión" queda repartida en varias filas unidas por `change_set_id`. Suficiente para v1; si se necesita una vista de fusiones de primera clase, se añade después.

---

## Cambios al núcleo

Ninguno estructural en las dimensiones (el audit es externo). Solo se añaden los **triggers** de auditoría sobre las tablas del §5.

## Pendiente

- Definir el dominio exacto de `op` y si `merge` merece su propia tabla de eventos de fusión (probablemente no en v1).
- Política de retención del propio audit-log (¿para siempre? probablemente sí: es barato y es el registro de integridad).
