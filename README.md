# Facturación Electrónica SIFEN

Plataforma SaaS multi-tenant para emitir documentos electrónicos ante SIFEN (DNIT, Paraguay): generación del XML, firma, envío por lote, KuDE, eventos y webhooks. Se expone como API asíncrona para integradores y como portal web. Node.js 22, NestJS (Fastify), Next.js, PostgreSQL 16 con RLS y Redis + BullMQ.

## Estado

Fase 0 (fundaciones y PoC) en curso. Ver el [roadmap](docs/roadmap.md) y el [backlog](docs/backlog/mvp.md).

## Inicio rápido

Requiere Node.js >=22.22.2 <23, pnpm 12.5.1, Docker con Compose v2 y git.

```bash
pnpm install
docker compose up -d                 # PostgreSQL 16 y Redis 7
pnpm build:api
pnpm --filter @sifen/api start:dev   # API en http://localhost:3000
# Documentación de la API: http://localhost:3000/docs
```

El portal (`pnpm --filter @sifen/web dev`) corre en http://localhost:3001.

## Documentación

| Documento | Contenido |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Punto de entrada: arquitectura, seguridad, pruebas y comandos |
| [`CLAUDE.md`](CLAUDE.md) | Reglas de oro de Git, ramas, commits y PRs |
| [`docs/desarrollo.md`](docs/desarrollo.md) | Puesta en marcha local, base de datos, migraciones y portal |
| [`docs/configuracion.md`](docs/configuracion.md) | Variables de entorno y proxies de confianza |
| [`docs/operacion.md`](docs/operacion.md) | CLI de operación y worker de transmisión |
| [`docs/prd/prd.md`](docs/prd/prd.md) | Producto: actores, flujos, requisitos |
| [`docs/roadmap.md`](docs/roadmap.md) | Fases y gates de salida |
| [`docs/backlog/mvp.md`](docs/backlog/mvp.md) | Historias del MVP |
| [`docs/adr/`](docs/adr/README.md) | Decisiones de arquitectura |
| [`docs/plan/plan-desarrollo-v1.1.md`](docs/plan/plan-desarrollo-v1.1.md) | Diseño técnico |
| [`docs/referencia/`](docs/referencia/README.md) | Normativa y ejemplos oficiales de la DNIT |

## Verificación

`pnpm check` corre lint, typecheck, depcruise y tests; `pnpm format:check` verifica el formato. El detalle de los gates está en [`AGENTS.md`](AGENTS.md#pruebas).
