# Spike ESEF/UKSEF — encargo

> Contexto: `docs/esef/propuesta.md` (P19). Este spike es **de solo lectura** y produce datos para cerrar la propuesta. No implementa nada del modelo.
> Duración objetivo: ½–1 día. Entregable: `docs/esef/spike-resultado.md` + línea en `docs/registro.md`.

## Reglas del spike

- **Nada de migraciones, tablas, seeds ni cambios en `src/normalizer/` o `src/validation/`.** Ni escrituras en la base de datos.
- Código del spike en `spikes/esef/` (TypeScript con `tsx`, `fetch` nativo). Se puede subir: es de usar y tirar, pero deja rastro de cómo se midió.
- Payloads descargados en `fixtures/esef/` (está en `.gitignore`; **no se suben**, igual que los de EODHD).
- Cortesía con la API: **una petición por segundo como máximo**, `User-Agent` con contacto (reutilizar el valor de `SEC_USER_AGENT` de `.env`, sin variable nueva).
- Llamadas a EODHD: solo si el plan actual incluye `fundamentals` (comprobar con `npm run quota`). Si no, reutilizar lo que haya en `fixtures/eodhd/` y marcar lo demás como **no verificado**, sin rellenar de memoria.
- Lo que no se pueda verificar se dice explícitamente (regla de `CLAUDE.md`).

## Muestra

Unas 20 empresas, elegidas para cubrir los casos difíciles. Los símbolos de EODHD están **a confirmar**.

| País | Empresas | Por qué |
|---|---|---|
| ES | Inditex (`ITX.MC`), Santander (`SAN.MC`), Iberdrola (`IBE.MC`) | Ejercicio que cierra en enero; banco (sin `Revenue`) |
| DE | SAP (`SAP.XETRA`), Siemens (`SIE.XETRA`), Allianz (`ALV.XETRA`) | Ejercicio a septiembre; aseguradora; SAP presenta también en la SEC |
| FR | LVMH (`MC.PA`), TotalEnergies (`TTE.PA`), Airbus (`AIR.PA`) | |
| NL | ASML (`ASML.AS`) | También presenta en la SEC |
| IT | Enel (`ENEL.MI`) | |
| Nórdicos | Novo Nordisk (`NOVO-B.CO`), Volvo (`VOLV-B.ST`), Nokia (`NOKIA.HE`) | DKK / SEK; doble clase de acción |
| UK | Shell (`SHEL.LSE`), AstraZeneca (`AZN.LSE`), Unilever (`ULVR.LSE`), BP (`BP.LSE`), HSBC (`HSBA.LSE`) | UKSEF; GBX frente a GBP; banco; reporta en USD |

## Preguntas que tiene que contestar

### Q1. Cobertura de la API
- Nº de informes por país y por ejercicio (FY2021–FY2025), **incluido GB**. Tabla país × año.
- Qué campos trae cada recurso `filings` y `entities` (lista real de atributos de un payload, no de la doc): identificadores (`fxo_id`, hashes), LEI, país, fechas (`period_end`, `processed`, `date_added`…), URLs (`json_url`, `report_url`, `viewer_url`), recuento de errores.
- Paginación real, tamaño máximo de página, tiempos de respuesta y si aparece algún límite de uso.
- Duplicados: ¿cuántos informes de la muestra aparecen más de una vez (varios países, idiomas, correcciones)? ¿Qué campo los une?

### Q2. Forma del xBRL-JSON
- Estructura real: dónde están los hechos, cómo vienen `concept`, `entity`, `period`, `unit`, `decimals` y las dimensiones.
- El valor, ¿viene como texto exacto? ¿Escalado o completo?
- Nº de hechos por informe: total y **sin dimensiones**. Tamaño del JSON. Con eso, estimar filas y tamaño de `esef_fact` para FY2021–FY2025 en todos los países.

### Q3. Conceptos
Para cada empresa de la muestra y cada columna de la tabla 6 de la propuesta: ¿aparece el concepto IFRS estándar sin dimensiones, aparece una extensión equivalente o no aparece? Tabla empresa × columna con `std` / `ext:<nombre>` / `—`. Resumen: % de cobertura estándar por columna, separando banca y seguros.

### Q4. Identidad
- ¿Trae EODHD `General.LEI` en las empresas europeas y británicas? ¿Coincide con el LEI del informe?
- Si no lo trae: ¿se resolvería con GLEIF (LEI → ISIN) contra el `General.ISIN` de EODHD? Probarlo a mano en 3–4 casos.
- Casos de doble clase (Novo, Volvo): un LEI, varios ISIN.

### Q5. Comparación de prueba (en memoria, sin escribir)
Con los fundamentales anuales de EODHD que haya para la muestra:
- Emparejar por fecha de cierre (¿basta la ventana de 7 días de `secPeriodWindowDays`?).
- Diferencia relativa por columna y empresa. Distribución: cuántas caen en ≤0,1 %, 0,1–2 % y >2 %.
- Clasificar las >2 % mirando el visor: error de EODHD, criterio distinto (p. ej. patrimonio total frente a atribuible), signo, escala, reexpresión, moneda.

### Q6. Reino Unido y monedas
- En `SHEL.LSE` (y otra británica): ¿`FUNDAMENTALS` vendría en GBP, GBX o USD? ¿Y el informe? ¿Hace falta `src/fx/subunits.ts` en la comparación?
- Empresas que reportan en una moneda distinta de la de cotización (Shell y HSBC en USD): ¿qué moneda trae EODHD en sus estados?

### Q7. Choque con la SEC
- SAP y ASML presentan también en la SEC. ¿Tienen CIK en `COMPANY`/EODHD? Confirmar que una fila de `FUNDAMENTALS` podría recibir findings de las dos fuentes (justifica la regla `ESEF_MISMATCH` separada).

## Entregable: `docs/esef/spike-resultado.md`

1. Resumen de una pantalla: qué se confirma, qué cambia de la propuesta y recomendaciones.
2. Una sección por pregunta (Q1–Q7) con tablas y la evidencia (qué payload, qué fecha, qué llamada).
3. **Cambios propuestos a `docs/esef/propuesta.md`**: columnas definitivas de `esef_filing` y `esef_fact`, conceptos que se caen o cambian, si hace falta GLEIF, tolerancias a la vista de la distribución real.
4. Lo que quedó sin verificar y por qué.

Al terminar: línea en `docs/registro.md`, commits pequeños en español y **parar**: el diseño final se decide en la conversación con David, no en el código.
