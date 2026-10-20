# Medición: compresión de los xBRL-JSON de ESEF

> Medido el 2026-10-20 en la rama `esef-segunda-fuente`. Solo medición: no toca `src/`, `db/`, la propuesta ni la base de datos.
> Código: `spikes/esef/compress.ts` (medición) y `spikes/esef/compress-sum.ts` (resumen y extrapolación). Entrada: los 32 informes de `fixtures/esef/json/` del spike (`spike-resultado.md`, Q2). Salidas en `fixtures/esef/` (no se suben).

## Método

- Node v22.23.3 (`zlib` nativo), Windows 11, un solo hilo, **una pasada por informe y método**; los tiempos son de una máquina de desarrollo y no de un servidor.
- `gzip` nivel 9; `brotli` calidad 11 (ventana 24 bits, `SIZE_HINT` = tamaño del informe); `zstd` nivel 19 (`zlib.zstdCompressSync`, que esta versión de Node trae; no hizo falta el CLI).
- Cada descompresión se compara byte a byte con el original; ninguna difirió.
- «Bruto» es el JSON ya descomprimido tal como se guarda en `fixtures/esef/json/`. La descarga de la API ya viaja en gzip (`content-encoding: gzip`), pero el tamaño transferido no se registró.
- Grupos como en la tabla de Q2: **primer ejercicio** (nombre del fichero con cierre en 2021; 15 informes) y **posteriores** (17). En Q2 el reparto era 16/16 por una suposición mía; el recuento real de ficheros es 15 + 17.

## Resultado en los 32 informes

| | Bruto | gzip -9 | brotli 11 | zstd 19 |
|---|---|---|---|---|
| **Total (32)** | 260,9 MB | 14,8 MB (5,7 %; 17,6×) | **4,45 MB (1,7 %; 58,6×)** | 5,35 MB (2,0 %; 48,8×) |
| Primer ejercicio (15) | 6,0 MB (medio 0,40) | 0,51 MB (8,5 %) | 0,40 MB (6,6 %) | 0,43 MB (7,2 %) |
| Posteriores (17) | 254,9 MB (medio 15,0; mediano 7,9) | 14,3 MB (5,6 %) | 4,05 MB (1,6 %) | 4,91 MB (1,9 %) |

Tiempos (suma de los 32 informes; entre paréntesis, por informe y rendimiento sobre el bruto):

| | Compresión | Descompresión |
|---|---|---|
| gzip -9 | 3,4 s (105 ms; 78 MB/s) | 0,46 s (14 ms; 567 MB/s) |
| brotli 11 | **218 s** (6,8 s; 1,2 MB/s) | 0,72 s (23 ms; 361 MB/s) |
| zstd 19 | 63,5 s (2,0 s; 4,1 MB/s) | 0,41 s (13 ms; 633 MB/s) |

Por informe (todos los de la muestra) están en `fixtures/esef/compress-run.txt` y `fixtures/esef/compress-out.json`. Casos extremos: Iberdrola 2024 (42 MB bruto) y Santander 2025 (38 MB) son los que más pesan; los informes del primer ejercicio van de 0,1 a 1,2 MB.

Lectura: el JSON comprime muy bien (claves repetidas). brotli 11 gana en tamaño (≈ 17 % menos que zstd 19), pero tarda ~3,4 veces más en comprimir. La descompresión es barata en los tres (13–23 ms por informe).

## Extrapolación a los informes del índice

Base: 13 638 pares `(LEI, cierre)` del índice entre 2021-01 y 2026-06, sin Ucrania (la misma cifra que Q2): **2 663 con cierre en 2021** y **10 975 posteriores**. Se multiplica el tamaño medio por informe de cada grupo de la muestra. Incluye informes intermedios, que el índice no distingue (ver `spike-resultado.md` Q1), así que es una cota alta.

| Método | Cierre 2021 (2 663) | Posteriores (10 975) | **Total (13 638)** |
|---|---|---|---|
| Bruto | 1,07 GB | 164,6 GB | **165,6 GB** |
| gzip -9 | 0,09 GB | 9,2 GB | **9,3 GB** |
| brotli 11 | 0,07 GB | 2,6 GB | **2,7 GB** |
| zstd 19 | 0,08 GB | 3,2 GB | **3,2 GB** |

Tiempo de compresión de todo el lote en un hilo con estos rendimientos: gzip -9 ≈ 35 min; zstd 19 ≈ 11 h; brotli 11 ≈ 38 h. Descompresión de un informe medio: 13–41 ms; en los dos más grandes (Iberdrola 42 MB, Santander 38 MB): 51–89 ms con gzip y zstd y 160–200 ms con brotli. Reintentar o regenerar `esef_fact` lee del crudo, así que este coste de lectura es el que cuenta.

**Cautelas**
- **Sesgo de la muestra:** son 16 grandes cotizadas, con informes de 15 MB de media en los recientes (mediana 7,9 MB). Si el informe típico del índice fuese la mediana y no la media, los totales bajarían aproximadamente a la mitad; una cotizada pequeña pesa mucho menos. No se ha medido.
- **Ratio de compresión:** depende del contenido (XML/JSON repetitivo). Los informes del primer ejercicio comprimen peor (11–15×) que los posteriores (18–63×), por lo que mezclar ambos ratios daría un resultado distinto del medido por grupos.
- Tiempos de una sola pasada en una máquina y sistema concretos; no hay repeticiones ni varianza.

## Postgres (TOAST pglz y lz4): no medido

La parte de Postgres **no se midió**: Docker no estaba levantado (`failed to connect to the docker API … dockerDesktopLinuxEngine`) y la tarea decía medirlo solo si lo estaba. No se arrancó Docker ni se creó ninguna tabla. Sin cifras, no se estima aquí cuánto ocupa `bytea` con TOAST por defecto ni con `lz4`; hay que medirlo con Docker levantado (la tabla temporal con los 32 cuerpos y `pg_column_size`, tal como se describió) antes de decidir si el crudo se comprime en la aplicación o lo hace la base de datos. Una cosa a tener en cuenta cuando se mida: TOAST comprime y trocea valores de hasta 1 GB, pero con `pglz` (por defecto) el ratio sobre JSON suele quedar por debajo del de gzip; es una expectativa, no un resultado.

## Resumen

- Bruto de ~166 GB para el índice completo (estimación alta); con zstd 19 ≈ 3,2 GB, con brotli 11 ≈ 2,7 GB, con gzip -9 ≈ 9,3 GB.
- La descompresión no es un cuello de botella en ninguno (≤ 41 ms por informe medio; ≤ 200 ms en los más grandes).
- La compresión sí pesa con brotli 11 (1,2 MB/s) y zstd 19 (4 MB/s); gzip -9 (78 MB/s) es el único que se comprime en minutos.
- Falta medir Postgres.
