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
pnpm --filter @sifen/api start:dev   # API en http://localhost:3000; NODE_ENV=development y PORTAL_ORIGIN=http://localhost:3001
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


## Portal web

El portal del cliente vive en `apps/web` (Next.js + Tailwind v4, diseño SifenFlow de Stitch).

```bash
pnpm --filter @sifen/web dev     # http://localhost:3001, panel de control con datos de ejemplo
pnpm --filter @sifen/web test    # tests de componentes (Vitest + Testing Library)
pnpm --filter @sifen/web build   # build de producción (descarga las fuentes de Google)
```
