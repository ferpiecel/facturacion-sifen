# Desarrollo local

Guía de puesta en marcha. Las reglas del repositorio están en [`AGENTS.md`](../AGENTS.md) y [`CLAUDE.md`](../CLAUDE.md); las variables de entorno, en [`configuracion.md`](configuracion.md); la operación con el CLI, en [`operacion.md`](operacion.md).

## Requisitos

- Node.js >=22.22.2 <23 (hay `.nvmrc`; con 22.22.0 `pnpm install` falla por `ERR_PNPM_UNSUPPORTED_ENGINE`).
- pnpm 12.5.1 (`corepack enable` con corepack ≥ 0.36). Si el corepack de tu Node es más viejo, usá `npx pnpm@12.5.1`.
- Docker con Compose v2 (Docker Engine, o Docker Desktop con integración WSL). Hace falta para `docker compose up -d` y para los tests con testcontainers de `pnpm check`.
- git.

## Arranque

```bash
pnpm install
pnpm check            # lint, typecheck, depcruise y tests (los de base de datos usan Docker)
docker compose up -d  # PostgreSQL 16 y Redis 7
pnpm build:api        # turbo run build --filter=@sifen/api...: compila también los paquetes de los que depende (p. ej. @sifen/db)
pnpm --filter @sifen/api start:dev   # API en http://localhost:3000; NODE_ENV=development (PORTAL_ORIGIN=http://localhost:3001 por defecto)
# Documentación de la API de integradores: http://localhost:3000/docs (spec: /docs/openapi.json)
```

Así la API arranca sin base de datos: `/health` responde 200 y las rutas protegidas responden `503`. Para usarlas, aplicá las migraciones y arrancá la API con `DATABASE_URL`. Las migraciones corren con el rol dueño (`sifen`) y crean el rol `app_login` sin contraseña, que se define aparte.

## Base de datos y migraciones

Los comandos siguientes aplican las migraciones y fijan la contraseña de `app_login` (solo desarrollo local):

```bash
export POSTGRES_URL="postgresql://sifen:sifen@localhost:5432/sifen"   # rol dueño de docker-compose.yml
DATABASE_URL="$POSTGRES_URL" pnpm --filter @sifen/db exec drizzle-kit migrate
docker compose exec postgres psql -U sifen -d sifen -c "ALTER ROLE app_login PASSWORD 'app_login'"   # solo desarrollo local
DATABASE_URL="postgresql://app_login:app_login@localhost:5432/sifen" pnpm --filter @sifen/api start:dev
```

Para crear partners, tenants y API keys, ver [Operación](operacion.md).

`start:dev` fija `NODE_ENV=development` y `PORTAL_ORIGIN=http://localhost:3001`. `pnpm --filter @sifen/api start` a secas se comporta como producción y no arranca sin `PORTAL_ORIGIN` (fail fast intencional). `/health` responde 200.

`/docs` (visor Redoc, carga el script desde un CDN fijado con SRI) y `/docs/openapi.json` no requieren API key, pero solo responden con `NODE_ENV` `development` o `test`, o con `API_DOCS_ENABLED=true`; en cualquier otro caso devuelven `404`.

## Verificación local

`pnpm verify` corre los quality-gates del CI (format, lint, typecheck, depcruise, test, build, verify-vendor, coverage) solo sobre los paquetes afectados respecto de `origin/main`. Imprime una línea (`verify OK ...`) o `verify FAIL <tarea>` con las líneas que fallan; el log completo queda en `.verify.log`. `pnpm install` activa el hook `.githooks/pre-push` (script `prepare`), que lo ejecuta antes de cada push; para saltearlo en una emergencia: `git push --no-verify`. Los jobs con Docker (`db-postgres`, `worker-redis`) siguen solo en CI. Los tests de los scripts de verificación se corren con `pnpm test:scripts`.

## Portal web

El portal del cliente vive en `apps/web` (Next.js + Tailwind v4, diseño SifenFlow de Stitch).

```bash
pnpm --filter @sifen/web dev     # http://localhost:3001, panel de control con datos de ejemplo
pnpm --filter @sifen/web test    # tests de componentes (Vitest + Testing Library)
pnpm --filter @sifen/web build   # build de producción (descarga las fuentes de Google)
```

## Probar el portal de punta a punta

Levanta todo en local con datos de ejemplo: Postgres, Redis, API en el puerto 3000, worker con el simulador y portal en el puerto 3001 (los valores por defecto: `PORTAL_ORIGIN=http://localhost:3001` en la API y `API_INTERNAL_URL=http://localhost:3000` en el portal). Cada bloque va en su propia terminal, desde la raíz del repositorio.

```bash
# 1. Postgres y Redis, migraciones como rol dueño y contraseña de app_login (solo desarrollo)
docker compose up -d --wait
export POSTGRES_URL="postgresql://sifen:sifen@localhost:5432/sifen"
DATABASE_URL="$POSTGRES_URL" pnpm --filter @sifen/db exec drizzle-kit migrate
docker compose exec postgres psql -U sifen -d sifen -c "ALTER ROLE app_login PASSWORD 'app_login'"

# 2. Compilar la API y sus paquetes
pnpm build:api

# 3. Datos de ejemplo (idempotente; ver abajo)
NODE_ENV=development OPS_DATABASE_URL="$POSTGRES_URL" pnpm dev:seed

# 4. API en http://localhost:3000 (terminal 1)
cd apps/api && NODE_ENV=development PORTAL_ORIGIN=http://localhost:3001 \
  DATABASE_URL="postgresql://app_login:app_login@localhost:5432/sifen" node dist/main.js

# 5. Worker con el simulador (terminal 2; solo hace falta para emitir documentos nuevos por la API)
openssl req -x509 -newkey rsa:2048 -nodes -keyout /dev/null -out /tmp/dev-roots.pem -days 30 \
  -subj "/CN=dev-root" -addext "basicConstraints=critical,CA:TRUE"   # raíz PSC descartable: el worker exige el bundle
cd apps/api && NODE_ENV=development SIFEN_GATEWAY=simulator REDIS_URL=redis://localhost:6379 \
  DATABASE_URL="postgresql://app_login:app_login@localhost:5432/sifen" \
  WORKER_PLATFORM_DATABASE_URL="postgresql://sifen:sifen@localhost:5432/sifen" \
  KMS_LOCAL_MASTER_KEY="$(openssl rand -base64 32)" PSC_TRUSTED_ROOTS_PATH=/tmp/dev-roots.pem \
  node dist/worker/worker.js

# 6. Portal en http://localhost:3001 (terminal 3)
pnpm --filter @sifen/web dev
```

`pnpm dev:seed` crea el partner "Partner Demo", el tenant "Demo SA" (perfil fiscal, establecimiento, punto y timbrado), un usuario `owner`, una API key de prueba y seis documentos: dos aprobados, uno rechazado con mensaje de SIFEN, uno aprobado con observaciones, uno en cola y uno cancelado. Imprime el email, la contraseña y la API key (esta última solo la primera vez: no se puede recuperar; para otra, `pnpm --filter @sifen/api ops apikey:create`). Reglas:

- Se niega a correr si `NODE_ENV` no es exactamente `development` o `test`, o si `OPS_DATABASE_URL` no apunta a `localhost`, `127.0.0.1` o `[::1]` (ni siquiera con `?host=`).
- Es idempotente: el tenant se busca por nombre y los documentos tienen CDC determinístico por número, así que repetirlo no duplica. Si falló a medias, partí de una base limpia (`docker compose down -v`).
- Los usuarios, tenants y datos fiscales salen de los mismos comandos del CLI de operación ([Operación](operacion.md)). Los documentos **no** pasan por `POST /v1/documents` y el worker: el simulador solo responde "aprobado" y no hay forma de obtener rechazados, observados o cancelados por ese camino. Se insertan ya en su estado final con un XML real (builder de TIPS, firma XMLDSig con un certificado descartable en memoria y QR con el CSC público de ejemplo), así que las descargas de XML y KuDE funcionan. El documento en cola lleva `next_transmission_at` a un año para que un worker en marcha no lo pase a "enviado".
- El tenant de demostración sirve para navegar el portal. Emitir documentos nuevos por la API además exige cargar un certificado y un CSC con el CLI de operación (ver [Operación](operacion.md)); el seed deja la numeración en 6 para que el siguiente documento sea el 7.
- Los documentos de demostración comparten emisor, timbrado y fecha de emisión del XML (30/09/2026); solo cambian número y receptor.

Primer ingreso en http://localhost:3001/login con `owner@demo.example.com` y `Tigre-Azul-Mesa-2026`. Como el usuario no tiene MFA, el portal pasa a la pantalla de enrolamiento: escaneá el QR con una app TOTP (o cargá el secreto a mano), ingresá el código de 6 dígitos y guardá los diez códigos de recuperación, que no se vuelven a mostrar. La sesión queda iniciada en el tenant "Demo SA". En desarrollo la sesión absoluta dura 20 minutos (`SESSION_ABSOLUTE_TTL_SECONDS`); al vencer, el ingreso siguiente pide el código TOTP. Para repetir el enrolamiento hay que partir de una base limpia.

Verificación sin navegador (cookies `__Host-` por HTTP funcionan con `curl` sobre `localhost`; el `Origin` debe ser el del portal):

```bash
P=http://localhost:3001; O="Origin: $P"
curl -s -c jar -b jar -H "$O" -H 'content-type: application/json' \
  -d '{"email":"owner@demo.example.com","password":"Tigre-Azul-Mesa-2026"}' $P/api/auth/login   # {"status":"mfa_enrollment_required"}
curl -s -c jar -b jar -H "$O" -X POST $P/api/auth/mfa/enroll                                       # {"otpauthUri":"otpauth://totp/...","secret":"..."}
curl -s -c jar -b jar -H "$O" -H 'content-type: application/json' -d '{"code":"<TOTP>"}' $P/api/auth/mfa/confirm
curl -s -b jar $P/api/portal/documents                                                              # lista de los seis documentos
curl -s -b jar $P/api/portal/documents/<id>                # detalle y eventos
curl -s -b jar $P/api/portal/documents/<id>/xml -o de.xml  # XML firmado
curl -s -b jar $P/api/portal/documents/<id>/kude -o de.pdf # KuDE (PDF)
curl -s -b jar "$P/api/portal/summary?from=2026-01-01&to=2026-01-31"   # resumen del período (por defecto, últimos 30 días)
```

Para apagar todo: `Ctrl+C` en cada terminal y `docker compose down -v` (el `-v` borra los datos).
