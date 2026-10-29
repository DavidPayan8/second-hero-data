# Panel ESEF en Azure

Panel web para revisar `esef_lei_isin` y ver `payload_blob`. Diseño: `docs/superpowers/specs/2026-10-28-panel-esef-design.md`.

- URL: https://sh-admin-hhxcr.azurewebsites.net (App Service Linux, plan gratuito F1, Node 22, solo HTTPS), grupo `rg-second-hero-dev`, región `spaincentral`.
- Usuarios: `david` y `alberto`. Las claves están en `C:\Users\MIGUEL\.second-hero-azure.txt` (fuera de cualquier repo), igual que las de la BD. Entrega la de Alberto por un canal privado.
- Límite: 10 logins fallidos por IP en 15 minutos. El plan F1 se duerme sin tráfico: la primera petición tarda unos segundos.

## Cómo está montado

- La app conecta a la BD con el rol `sh_review`: hereda `sh_readonly` (SELECT) y solo tiene `UPDATE` sobre `esef_lei_isin`. No puede escribir en nada más. Pertenecer a `sh_readonly` hace que sus permisos de lectura sobrevivan a `pg_restore --clean`.
- Variables del servicio: `DATABASE_URL`, `ADMIN_USERS` (hashes scrypt), `ADMIN_SESSION_SECRET`, `ADMIN_TRUST_PROXY=1`, `ADMIN_HOST=0.0.0.0`, `NODE_ENV=production`. Comando de arranque: `node dist/cli.js admin`.
- Cambiar una clave: `npm run admin-hash -- <clave nueva>`, editar `ADMIN_USERS` con `az webapp config appsettings set` (pásalo con `@fichero.json` para no tener problemas de comillas en Windows) y borrar el fichero.

## Desplegar una versión nueva

1. `npx tsc -p tsconfig.build.json` (genera `dist/`), copiar `src/admin/public/*` a `dist/admin/public/`.
2. Carpeta de despliegue con `dist/`, un `package.json` solo con `dotenv` y `pg` y su `node_modules` (`npm install --omit=dev`).
3. Comprimir con **Python** (`zipfile`, rutas con `/`). `tar -a` de Windows y `Compress-Archive` produjeron zips que Azure aceptaba sin extraer nada.
4. `az webapp deploy -g rg-second-hero-dev -n sh-admin-hhxcr --src-path <zip> --type zip --track-status false`. Esperar ~1 minuto y comprobar `/api/me` (debe dar 401).

## Resincronizar la BD local con Azure sin perder las decisiones

`esef_lei_isin` se decide en Azure, así que la copia completa **no debe incluirla**:

```
pg_dump -Fc --no-owner --no-acl --exclude-table=esef_lei_isin ...
pg_restore --clean --if-exists --no-owner --no-acl -j 2 ...
```

Con la tabla fuera del volcado, `--clean` no la borra. Comprobado con `pg_restore -l`: el volcado no menciona `esef_lei_isin`. Una migración futura que cambie esa tabla hay que aplicarla en Azure a mano (`npm run db:migrate` con la URL de Azure).

## Mover datos de esta tabla

- `npm run esef-push-candidates [-- --go]`: sube a Azure las filas que solo existen en local (candidatos nuevos de `esef-identify`). Nunca pisa.
- `npm run esef-pull-reviews [-- --go]`: trae a local lo revisado en Azure. Gana la revisión humana más reciente; una vuelta a Pendiente en Azure también se copia. Una fila `auto` nunca pisa a otra.
- Ambos piden `AZURE_DATABASE_URL` en `.env` y son dry-run sin `--go`.

## Pendiente conocido

- `payload_blob` solo está en Azure por la copia del 2026-10-28: las capturas nuevas hay que resincronizarlas.
- La licencia de EODHD para enseñar sus datos a terceros no está confirmada (ver memoria `second-hero-migracion-nube`).
