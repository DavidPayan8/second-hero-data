# Decisiones de diseño — Taxonomía sectorial

Pieza previa a VISTAS. Convierte `COMPANY.sector`/`industry` (texto libre) en una clasificación canónica propia, porque el Business Score rankea por **percentil dentro de sector × región** y el texto libre fragmenta el grupo de pares. Dependencia dura de la capa de lectura: se decide **antes** de diseñar el score.

Estado: **cerrado**.

---

## 0. El problema

El ranking del score agrupa a las empresas en peer groups y calcula percentiles dentro de cada uno. Con `sector` como texto libre ("Technology" / "Tech" / "Information Technology"), el peer group se parte en cubos basura y el percentil pierde sentido. Además, los **casos especiales** del score (bancos, aseguradoras, REITs usan métricas distintas) exigen **identificar** esos grupos de forma determinista, no adivinando sobre un string.

---

## 1. Decisión: taxonomía propia con mapeo (Opción C)

Taxonomía canónica **propia**, estructurada *como* GICS pero con nuestros códigos y nombres, poblada desde el proveedor vía una tabla de mapeo `SOURCE_SECTOR_MAP`.

**Por qué no B (GICS oficial):** GICS es propiedad de S&P/MSCI y lo licencian agresivamente. Replicar su jerarquía y códigos oficiales en un producto comercial expuesto es un riesgo de propiedad intelectual innecesario. (No es un dictamen legal; es evitar el riesgo por diseño.)

**Por qué no A (proveedor tal cual):** EODHD categoriza distinto según la bolsa de origen → la fragmentación que destruye el score, heredada y fuera de nuestro control.

**Por qué C:** controlamos el modelo de datos y el algoritmo. El patrón de mapeo aísla la volatilidad del proveedor en la capa de ingesta (normalizador), dejando el núcleo financiero **completamente determinista**. Es el mismo patrón ya usado en `SOURCE_EXCHANGE`→MIC, `SOURCE_HOLDER_MAP` y el crosswalk de identidad: valor crudo del proveedor → id canónico nuestro, con anclado y *mark-for-review* en lo desconocido.

---

## 2. Dos niveles: `SECTOR` + `INDUSTRY`

Dos niveles para v1 (sector y, dentro, industria). Un tercer nivel (sub-industria) añade mantenimiento en la tabla de mapeo sin aportar valor inmediato al scoring. Con dos niveles se resuelven los casos especiales críticos:
- dentro del sector *Financials*, separar la industria *Banking* de *Insurance*;
- dentro de *Real Estate*, aislar la industria *REITs*.

Si v2 necesita más granularidad para un peer group concreto, la estructura relacional se extiende sin romper v1 (se cuelga un nivel de `INDUSTRY`).

---

## 3. Manejo de lo no clasificado: `sector_id` NULL, sin fila `unclassified`

`COMPANY.sector_id` e `industry_id` **nullable**. Lo no clasificado es `NULL`, **no** una fila `unclassified` en `SECTOR`.

Un registro `unclassified` en la dimensión canónica contaminaría una tabla de referencia con un **estado del proceso de ingesta**: "unclassified" no es un sector económico. `NULL` representa exactamente lo que ocurre (ausencia de clasificación). El score filtra con `WHERE sector_id IS NOT NULL` — limpio y estándar — y la empresa sin clasificar queda fuera del ranking sector-relativo (N/D), coherente con el umbral de cobertura (`ETF_ALLOCATION`). Mantiene "no inventar datos" aislando lo desconocido sin falsear el catálogo.

---

## 4. Dos FK independientes + trigger de consistencia

`COMPANY` gana `sector_id` **e** `industry_id`, ambos FK nullable, **independientes**:

- **Independientes** porque el proveedor puede dar sector mapeable sin industria mapeable (o al revés). Hay que poder registrar "sector conocido, industria desconocida" (`industry_id NULL`, `sector_id` puesto) sin perder la empresa del ranking.
- **Pero `industry_id` determina su sector** (`INDUSTRY.sector_id`). Por "no se almacena lo derivable sin ambigüedad", tener ambos invita a la deriva (que `COMPANY.sector_id` discrepe de `INDUSTRY.sector_id`). La guarda es la misma lección del CHECK de `asset_type`: **un CHECK no ve otra tabla → es un trigger**. Cuando ambos están puestos, el trigger en `COMPANY` exige `COMPANY.sector_id = INDUSTRY.sector_id`. Conocimiento parcial permitido, drift bloqueado.

---

## 5. Mapeo: `SOURCE_SECTOR_MAP`

`SOURCE_SECTOR_MAP (provider, provider_sector_label, provider_industry_label) → (sector_id, industry_id)`.

- Resuelve a **`industry_id`** cuando puede (el sector viene incluido vía `INDUSTRY.sector_id`).
- Resuelve a **solo `sector_id`** cuando la industria del proveedor no es mapeable pero el sector sí.
- **Sin mapeo** → marcar para revisión; la company queda con ambos NULL hasta que un humano añade la fila de mapeo. Mismo *mark-for-review* que companies `isolated` y re-enlaces de identidad.
- Vive en el **normalizador** (capa de ingesta), como el resto de `SOURCE_*`. La reclasificación de una company queda auditada por `DIMENSION_AUDIT` (gratis, ya cubre `COMPANY`).
- **Doble uso:** la misma tabla resuelve también el `bucket` de `ETF_ALLOCATION` (cuando `dimension='sector'`) a `SECTOR`, unificando el vocabulario sectorial de acciones y ETFs. Un único mapa, dos consumidores (`COMPANY` y `ETF_ALLOCATION`).

---

## Cambios al núcleo

- `COMPANY`: se **elimina** `sector`/`industry` (texto libre); se añaden `sector_id` FK e `industry_id` FK (ambos nullable) + trigger de consistencia (§4).
- Tablas nuevas de referencia: `SECTOR`, `INDUSTRY`.
- Tabla nueva de mapeo (normalizador): `SOURCE_SECTOR_MAP`.
- Recomendado auditar `SECTOR`, `INDUSTRY`, `SOURCE_SECTOR_MAP` con `DIMENSION_AUDIT` (dimensiones mutables de referencia).

## Pendiente / verificar en vivo

- Qué clasificación da EODHD por región (campos `Sector`/`Industry`, y si expone algo tipo GIC) → define el trabajo inicial de poblar `SOURCE_SECTOR_MAP`.
- Definir el set inicial de `SECTOR`/`INDUSTRY` propios (partir de la estructura GICS como *referencia conceptual* — 11 sectores — sin copiar códigos/nombres oficiales).
- Agrupación `sector × región`: confirmar el corte de regiones (US / Canadá / Europa) sobre `COMPANY.country_iso`; se aplica en VISTAS, no en la taxonomía.
