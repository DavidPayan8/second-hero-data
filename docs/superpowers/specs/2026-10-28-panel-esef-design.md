# Panel web de revisión ESEF y visor de payload

Fecha: 2026-10-28. Estado: borrador para aprobar.

## Para qué sirve

La tabla `esef_lei_isin` (migración 019, propuesta P20) guarda los candidatos LEI -> ISIN que propone GLEIF. Hay 272 filas: 246 aceptadas automáticamente (`reviewed_by = 'auto'`) y 26 filas de 15 empresas en estado `proposed`. Esas 26 las tiene que decidir una persona. Hoy solo se puede con SQL en DBeaver, y los dos programadores (David y Alberto) quieren una pantalla clara para hacerlo. Los dos tienen el mismo nivel de conocimiento del dominio, pero Alberto no programa esta parte.

Además, `payload_blob.body` está en bytea, casi siempre `json+zstd`, y no se puede leer en un cliente SQL. Hace falta un visor que lo descomprima y lo muestre.

Se resuelven las dos cosas con una app web pequeña, alojada en Azure para que los dos la usen.

## Objetivos

- Pantalla de revisión: decidir fila a fila si un ISIN se vincula a su empresa o se rechaza.
- Pantalla de visor: buscar un `payload_blob` y ver el JSON ya descomprimido y parseado.
- Acceso para David y Alberto con usuario y clave, con `reviewed_by` tomado del usuario que entra.
- Que las decisiones tomadas en Azure se puedan traer a la base local.

## No objetivos

- No crea ni modifica `company` ni `security`. La opción (b) de P20 (contrastar con el normalizador) queda para cuando haya plan de pago de EODHD.
- No edita los 246 vínculos automáticos, aunque la pantalla puede mostrarlos en solo lectura (decisión del constructor).
- No es una app de producción ni para usuarios finales.
- No hay más pantallas (ingesta, métricas, etc.).

## Antiobjetivos (fallaría aunque funcione)

- Que una resincronización de la base a Azure borre las decisiones tomadas allí.
- Que un clic equivocado deje una fila revisada sin posibilidad de volver a Pendiente.
- Que el servicio quede abierto a internet sin acceso protegido.
- Que `alberto` (rol de solo lectura) gane escritura sobre algo distinto de `esef_lei_isin`.

## Pantalla de revisión (acordada con David)

- Una tarjeta por empresa: nombre, LEI y país del informe.
- Dentro, una fila por ISIN: ISIN, línea de bolsa (`matched_symbol`), tipo (`matched_type`), un aviso a la derecha y un interruptor de tres estados: Pendiente, Vincular, Rechazar. Vincular es verde y Rechazar es rojo.
- Bajo cada fila, una frase corta que explica qué significa vincular y rechazar.
- Barra de progreso arriba y botón "Aplicar sugerencias".
- Se guarda al pulsar cada interruptor, sin botón Guardar. Se puede volver a Pendiente.
- Vincular guarda `status = 'accepted'`; Rechazar guarda `'rejected'`; Pendiente guarda `'proposed'` y deja `reviewed_by` y `reviewed_at` en NULL (lo exige el CHECK de la tabla).
- Avisos (propuesta mía, falta confirmar los umbrales): "Sugerido" si el ISIN es el único candidato con el prefijo del país del informe; "Revisar" si es un ADR de EEUU, una segunda clase de acciones, o el prefijo no coincide con el país. Con doble clase (Volvo A y B) lo normal es vincular las dos; la app no obliga a una sola.
- Diseño cuidado e intuitivo. Maquetas aprobadas en la sesión: opción A (interruptor de tres estados), con la columna de avisos a la derecha tal como se ve en la maqueta `decision-v2.html`.

## Pantalla de visor

- Buscar por fuente, id o `content_hash`.
- Mostrar metadatos (fuente, endpoint, fecha, `body_format`, tamaños) y comprobar que el sha256 del cuerpo descomprimido coincide con `content_hash`.
- Mostrar el JSON como árbol plegable, como texto y, si es una lista de objetos, como tabla. Copiar y descargar como .json.
- Descompresión: `json+zstd` con `zlib.zstdDecompressSync` (disponible en el Node 22 del repo, comprobado); `json` se parsea directamente.
- Solo lectura. David y Alberto lo ven, con el aviso de licencia que ya consta en la memoria del proyecto: los datos de EODHD no tienen licencia confirmada para terceros, por eso el visor va detrás del acceso con clave.

## Dónde y cómo (decisiones de David)

- Vive en el repo `second-hero-data`, carpeta nueva `src/admin/`, script `npm run admin`.
- Se despliega en Azure, junto a la base `sh-dev-hhxcr` (región `spaincentral`, suscripción gratuita). Dos usuarios: David y Alberto.
- Las decisiones se hacen y se guardan en Azure. La resincronización de Azure deja de tocar `esef_lei_isin`.
- Un comando nuevo trae a la base local las filas revisadas por una persona (`status` distinto de `proposed` y `reviewed_by` distinto de `auto`). Nunca pisa una fila revisada con otra más antigua.
- El rol `alberto` recibe INSERT/UPDATE solo sobre `esef_lei_isin`; el resto sigue en solo lectura.

## Decisiones mías (David no las ha aprobado)

- Servidor Node con el módulo `http` y `pg`, página HTML con JavaScript sin framework, sin dependencias nuevas.
- Alojamiento: App Service plan gratuito F1 con Node; si no encaja, Container Apps.
- Acceso: usuario y clave por persona guardados con hash en la base (tabla nueva, o variables del servicio). Hay que decidir al planificar si se crea una migración 020 o se guardan en la configuración del servicio. Toda tabla nueva exige propuesta de cambio de modelo según `CLAUDE.md`.
- Comando de traída: `npm run esef-pull-reviews`.
- Conexión con TLS (`sslmode=require`) a Azure.

## Decisiones tras la revisión del documento (mías, a confirmar por David)

- **Candidatos nuevos:** `esef-identify` sigue corriendo en local. Un comando nuevo `npm run esef-push-candidates` inserta en Azure solo las filas que faltan (`on conflict do nothing`), sin tocar las que ya existen. La carga inicial de las 272 filas es el primer uso de ese comando.
- **Traída de revisiones (`esef-pull-reviews`):** Azure manda en esta tabla para las filas que una persona ha tocado. Se copian a local las filas de Azure con `reviewed_by` distinto de `auto` y las que han vuelto a `proposed` tras una revisión humana, de modo que una vuelta a Pendiente también se propaga. Si local y Azure difieren, gana la que tiene `reviewed_at` más reciente. Una fila `auto` solo se sustituye si en Azure ya la ha revisado una persona. La vuelta a Pendiente se detecta porque el comando compara el estado completo, no solo `reviewed_at`.
- **Acceso:** usuarios y claves en variables de entorno del servicio (hash de la clave), con sesión por cookie firmada. No hay tabla nueva ni migración 020. La app se conecta con un rol propio, `sh_review`, con SELECT en `esef_lei_isin`, `esef_filing` y `payload_blob` y UPDATE solo en `esef_lei_isin`. `alberto` conserva solo lectura en la base; escribe únicamente a través de la app. La identidad que se guarda en `reviewed_by` la pone la app a partir de la sesión.
- **Datos de los avisos:** el país del informe sale de `esef_filing.country`. "Revisar" aplica si el ISIN empieza por `US` y el país del informe no es `US` (ADR), o si el mismo LEI tiene otro ISIN con el mismo prefijo de país (segunda clase), o si el prefijo del ISIN no coincide con el país del informe. "Sugerido" aplica si ninguna de esas condiciones se cumple y el tipo es `Common Stock`.
- **Aplicar sugerencias:** pide confirmación, pasa a Vincular solo las filas Pendientes con aviso "Sugerido" y deja el resto sin tocar. No rechaza nada de forma automática.
- **Historial:** volver a Pendiente borra quién decidió antes. Se acepta en esta versión, porque es una herramienta de desarrollo. Un registro de cambios sería una propuesta de modelo aparte.
- **Alojamiento:** App Service F1 con despliegue por zip (`az webapp deploy`). El firewall de Azure ya está abierto a todo internet. Si F1 se queda corto, se pasa a Container Apps sin cambiar el diseño.
- **Visor:** busca en la base de Azure, que tiene `payload_blob` completo (volcado verificado el 2026-10-28). Se pone un tope de tamaño de cuerpo descomprimido (propongo 20 MB) y se avisa si se supera. La vista de tabla se ofrece solo cuando la raíz del JSON es un array de objetos.

## Pendiente para el constructor

- Diseño visual detallado y textos de ayuda.
- Rutas HTTP y estructura de la carpeta.
- Mecanismo exacto de acceso y de la sesión.
- Pruebas contra Postgres real en la base `_test`, como pide `CLAUDE.md`.
- Cambio en el procedimiento de resincronización para excluir `esef_lei_isin`, y documentarlo.
