# AGENTS.md

Punto de entrada para personas y agentes. Cada regla indica qué la hace cumplir; las que son solo convención lo dicen. Las reglas de oro de Git y PRs están en [`CLAUDE.md`](CLAUDE.md) y no se repiten aquí.

## Sistema

SaaS multi-tenant que emite documentos electrónicos ante SIFEN (DNIT, Paraguay): XML, firma, envío por lote, KuDE, eventos y webhooks. Cada tenant es facturador con su propio certificado ([ADR-0010](docs/adr/0010-cada-tenant-es-facturador.md)) y la jerarquía es partner → tenant ([ADR-0014](docs/adr/0014-jerarquia-partner-tenant.md)). Se expone como API asíncrona (202 + webhooks, [ADR-0011](docs/adr/0011-api-asincrona-202-webhooks-idempotencia.md)) y como portal web.

Stack: Node.js 22, TypeScript, NestJS sobre Fastify, Next.js, PostgreSQL 16 con RLS, Drizzle, Redis + BullMQ, pnpm + Turborepo ([ADR-0002](docs/adr/0002-node-typescript-con-librerias-tips.md), [0003](docs/adr/0003-nestjs-fastify-hexagonal.md), [0004](docs/adr/0004-monorepo-turborepo-pnpm.md), [0013](docs/adr/0013-drizzle-orm-y-bullmq.md)).

## Mapa del repositorio

| Ruta | Contenido |
|---|---|
| `apps/api` | API NestJS/Fastify, worker de transmisión (`src/worker/`, mismo código, otro entrypoint) y CLI de operación (`src/cli/`) |
| `apps/web` | Portal Next.js 16 |
| `packages/db` | Esquema Drizzle, migraciones SQL (`migrations/`), RLS, `withTenantTransaction` |
| `packages/sifen-tips` | Único paquete que importa las librerías `facturacionelectronicapy-*` de TIPS |
| `packages/sifen-gateway`, `packages/sifen-xsd`, `packages/config` | Contrato del gateway SIFEN, validación XSD, configuración compartida |
| `docs/` | PRD, roadmap, backlog, ADRs, plan técnico, normativa DNIT, API |
| `openspec/`, `odd/tasks/` | Specs y cambios SDD; documentos de tareas ODD |

## Arquitectura

Cada módulo de `apps/api/src/modules/<modulo>/` es hexagonal:

| Capa | Contiene | Puede importar |
|---|---|---|
| `domain/` | Entidades, value objects, reglas | Solo TypeScript puro |
| `application/` | Casos de uso y puertos (`application/ports/*.port.ts`) | `domain/` |
| `infrastructure/` | Adaptadores (`adapters/`), controllers y guards (`http/`, `guards/`), stores Drizzle | Todo lo anterior y frameworks |
| `<modulo>.module.ts` | Ensamblado con `useFactory` | Todas las capas |

Reglas, todas con severidad `error` en [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs) y verificadas por `pnpm depcruise`:

- `domain-app-framework-free`: `domain/` y `application/` no importan `@nestjs/*`, `@fastify/*`, `fastify`, `drizzle-orm`, `bullmq`, `ioredis`, `pg` ni `reflect-metadata` ([ADR-0003](docs/adr/0003-nestjs-fastify-hexagonal.md)). Sin decorators en esas capas.
- `domain-no-outer-layers` y `application-no-infrastructure`: la dependencia apunta siempre hacia adentro.
- `no-circular`: sin ciclos en todo el workspace.
- `tips-libs-confined-to-sifen-tips`: solo `packages/sifen-tips` importa `facturacionelectronicapy-*` ([ADR-0015](docs/adr/0015-tips-libs-emision.md)). Se usan detrás de puertos de emisión.
- [`apps/api/.dependency-cruiser.cjs`](apps/api/.dependency-cruiser.cjs), `db-confined-to-infrastructure-and-module-wiring`: `@sifen/db`, `drizzle-orm`, `pg` y PGlite solo se importan desde `modules/*/infrastructure/`, `*.module.ts`, `cli/` y `worker/`.
- `packages/db` y `packages/sifen-gateway` deben seguir libres de frameworks de aplicación (reglas `*-framework-free-local` en su propio `.dependency-cruiser.cjs`).
- `apps/web`: `design-system/` no importa `features/` ni rutas, y `features/` no importa `app/` ([`apps/web/.dependency-cruiser.cjs`](apps/web/.dependency-cruiser.cjs)).
- Solo `domain-app-framework-free`, `domain-no-outer-layers` y `application-no-infrastructure` tienen prueba con fixtures en [`apps/api/test/architecture/boundaries.spec.ts`](apps/api/test/architecture/boundaries.spec.ts); el resto se hace cumplir solo con `pnpm depcruise`.

Convenciones (sin enforcement automático): un puerto por responsabilidad, nombrado `*.port.ts`; los adaptadores llevan el nombre de la tecnología (`sql-*`, `drizzle-*`, `argon2-*`); no se usa `@nestjs/cqrs` (ADR-0003); las dependencias se versionan exactas en `package.json`.

## Seguridad

Invariantes. Si un cambio no puede respetarlas, se frena y se consulta.

**Aislamiento de tenant** ([ADR-0005](docs/adr/0005-multi-tenancy-rls-schema-compartido.md), [0006](docs/adr/0006-contexto-de-tenant-con-cls.md), [0016](docs/adr/0016-tenant-transaction-runner-sin-plugin-cls.md))

- Toda tabla con `tenant_id` tiene `ENABLE` y `FORCE ROW LEVEL SECURITY` y una política `FOR ALL` para `app_user` con `USING` y `WITH CHECK`. [`packages/db/test/rls-coverage.spec.ts`](packages/db/test/rls-coverage.spec.ts) lo descubre desde el catálogo: una tabla nueva sin RLS rompe el test. Cada tabla nueva lleva su migración de RLS (ver `migrations/0001_rls.sql` y sucesores).
- El runtime se conecta como `app_login` (`NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`) y opera con `SET LOCAL ROLE app_user`. Las migraciones corren con el rol dueño; la contraseña de `app_login` se define fuera de las migraciones. `assertNonPrivilegedSession` (`packages/db/src/session-guard.ts`) se invoca al crear el pool de la API y del worker y rechaza sesiones privilegiadas.
- Todo acceso a datos de un tenant pasa por `withTenantTransaction` (`packages/db/src/tenant-transaction.ts`), que fija `app.current_tenant` con `set_config` parametrizado. En la API lo usa el singleton `TenantTransactionRunner`; en el worker, `TenantAwareProcessor`. Sin contexto de tenant la consulta falla; nunca cae a un rol privilegiado.
- El `tenant_id` se valida como UUID con `assertValidTenantId` (`packages/db/src/tenant-id.ts`) antes de construir SQL. Nunca se interpola.
- La resolución de API key previa al tenant usa `withAppRoleTransaction` y las funciones `SECURITY DEFINER` `resolve_api_key` y `touch_api_key_last_used`, no lecturas directas. `platform_admin` es solo para jobs cross-tenant auditados.
- Lecturas por partner: `withPartnerTransaction` (`packages/db/src/partner-transaction.ts`) valida el UUID, fija `app.current_partner` y ejecuta `SET LOCAL ROLE partner_viewer`, rol `NOLOGIN` y `NOBYPASSRLS` con `SELECT` solo sobre columnas operativas de los tenants del partner (migración `0044_partner_status.sql`). Autorizar al usuario para ese partner es responsabilidad del llamador.
- Límite conocido (ADR-0016, adenda): nada impide a código dentro de `fn` volver a llamar `set_config`. Ningún código de dominio debe hacerlo.
- La suite de aislamiento (`packages/db/test/isolation.spec.ts`) es gate de release. Las pruebas de escape de rol solo corren en el job `db-postgres`.

**Secretos y custodia** ([ADR-0009](docs/adr/0009-custodia-certificados-kms.md))

- `.p12`, CSC, secretos MFA y secretos de webhook se sellan con envelope encryption (AES-256-GCM, data key envuelta por KMS) mediante el puerto `modules/custody/application/ports/key-management.port.ts`. Hoy el único adaptador es el KMS local (`local-kms.adapter.ts`); el adaptador de KMS en la nube está pendiente.
- El material descifrado vive solo en memoria, con caché de TTL corto (`CERTIFICATE_CACHE_TTL_MS`), y nunca va a disco, logs, errores ni respuestas. Cada descifrado queda en el audit log.
- El audit log es una cadena de hashes (`packages/db/src/audit-chain.ts`, migración `0018`); se verifica con `verifyAuditChain`.
- Las API keys se guardan solo como hash; la completa se imprime una única vez al emitirla.
- Nunca se suben `.p12`, CSC reales ni `.env` (`.gitignore` excluye `.env*` salvo `.env.example`). Las pruebas usan la PKI de `apps/api/test/support/test-pki.ts` y el CSC público de ejemplo.

**Configuración fail-fast**

- La API no arranca si falta `KMS_LOCAL_MASTER_KEY`, `AUTH_SUBJECT_PEPPER` o `PORTAL_ORIGIN` fuera de `NODE_ENV` exactamente `development` o `test`, ni sin `SIFEN_ENVIRONMENT` con `NODE_ENV=production` (`bootstrap/environment.ts`, `auth-http-config.ts`). Con `DATABASE_URL` inalcanzable tampoco arranca. Ver [`docs/configuracion.md`](docs/configuracion.md).
- El worker solo acepta `SIFEN_GATEWAY=simulator` con `NODE_ENV` `development` o `test` (`worker/worker-gateway.ts`). Además `worker/simulator-guard.ts` omite los tenants en `production` cuando el gateway es el simulador.
- Un valor por defecto permisivo en producción es un defecto. Las variables nuevas se validan al arrancar y se documentan en `docs/configuracion.md`.

**Autenticación del portal** (`modules/identity/`)

- Cookies `__Host-sifen_at`, `__Host-sifen_rt` y `__Host-sifen_pending`: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, sin `Domain` (`auth-cookies.ts`).
- CSRF por `Origin` exacto contra `PORTAL_ORIGIN` en toda ruta no segura de `/auth`; un `Origin` ausente o `null` se rechaza (`csrf.guard.ts`).
- `SessionGuard` relee las membresías en cada request: un rol cambiado o una membresía removida aplican de inmediato (`session.guard.ts`).
- Contraseñas con Argon2id con parámetros fijados (`domain/argon2-params.ts`); el HMAC de emails e IP del límite de intentos usa `AUTH_SUBJECT_PEPPER`.
- IP de cliente: `AUTH_TRUST_PROXY_HOPS=0` por defecto, es decir socket y `X-Forwarded-For` ignorado; nunca se confía en una cabecera cruda (`bootstrap/http.ts`, `client-ip.ts`). Detalle en [`docs/configuracion.md`](docs/configuracion.md).
- Portal (`apps/web`): proxy de mismo origen de `/api/auth/*` hacia la API (`next.config.ts`, `src/security/api-proxy.ts`), de modo que las cookies `__Host-` queden en el host del portal y el `Origin` coincida con `PORTAL_ORIGIN`; solo se expone `/auth/*`. `src/security/client-address.ts` fija `X-Forwarded-For` a la dirección del socket salvo `PORTAL_TRUSTED_UPSTREAM_PROXY=true`. `src/proxy.ts` redirige a `/login` si no hay cookie de sesión; solo comprueba presencia, la autoridad es la API.

**Webhooks salientes** ([ADR-0011](docs/adr/0011-api-asincrona-202-webhooks-idempotencia.md), [`docs/integracion/webhooks.md`](docs/integracion/webhooks.md))

- Anti-SSRF en `modules/webhooks/infrastructure/safe-webhook-http.ts` con la política de `domain/blocked-address.ts`: solo `https`, sin userinfo, y se rechaza el destino salvo que todas las direcciones resueltas sean públicas.
- Firma HMAC con marca de tiempo en `domain/webhook-signature.ts`; el receptor rechaza marcas a más de 5 min (`SIGNATURE_TOLERANCE_SECONDS`).
- Convención: los logs del worker llevan ids, conteos y nombres de error; nunca XML, certificados ni URLs.

## Reglas SIFEN

- Precedencia ([ADR-0012](docs/adr/0012-precedencia-documentacion-oficial.md)): notas técnicas vigentes > Guía de Pruebas 2026 > Guía de mejores prácticas 2024 > MT v150 > ejemplos. Ante una contradicción se aplica el documento más reciente o el más restrictivo y se confirma con el Prevalidador.
- Todo valor en disputa es configurable, no queda fijo en el código.
- Fuentes en [`docs/referencia/`](docs/referencia/README.md). `estructura-de-NO-v150.xsd` no corresponde a v150 y no se usa para validar; los XSD vigentes están en `packages/sifen-xsd`.
- Transmisión por lote como camino principal ([ADR-0007](docs/adr/0007-lote-como-camino-principal.md)); sin contingencia, con cola de plazo de 72 h ([ADR-0008](docs/adr/0008-sin-contingencia-cola-72h.md)).
- `POST /v1/documents` exige `Idempotency-Key` y responde 202 ([ADR-0011](docs/adr/0011-api-asincrona-202-webhooks-idempotencia.md)).

## Pruebas

- TDD estricto (`strict_tdd: true` en [`openspec/config.yaml`](openspec/config.yaml)): primero la prueba que falla, después el código. Convención del equipo; no la verifica el CI.
- Runner: Vitest. Los `*.spec.ts` viven junto al código; los e2e, en `apps/*/test/` con `inject()` de Fastify.
- Gate de cobertura: 85 % en líneas, ramas, funciones y sentencias, por paquete (`thresholds` en cada `vitest.config.ts`; entrada `coverage` de la matriz de `quality-gates`).
- `packages/db`: PGlite por defecto; el job `db-postgres` corre la misma suite en un testcontainer `postgres:16` con `DB_TEST_DRIVER=postgres` (`pnpm --filter @sifen/db test:postgres`). Lo que depende de roles reales solo se prueba ahí.
- Pruebas del worker con Redis real: `REDIS_URL=... pnpm --filter @sifen/api exec vitest run src/worker`; sin `REDIS_URL` se omiten y las corre el job `worker-redis`.
- El CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) corre el job `quality-gates` (matriz: `format:check`, `lint`, `typecheck`, `depcruise`, `test`, `build`, `verify-vendor`, `coverage`) y los jobs `db-postgres` y `worker-redis`.
- El test que compara `docs/api/openapi.json` con el código falla si el spec cambia sin regenerarse (`pnpm --filter @sifen/api openapi`).

## Flujo de trabajo

- Reglas de oro (rama por tarea, PR a `main` con revisión, commits convencionales, 400 líneas por PR): [`CLAUDE.md`](CLAUDE.md).
- Desarrollo orgánico (ODD) por defecto: el trabajo sustancial lleva un documento de tareas en [`odd/tasks/`](odd/tasks/). SDD (specs y cambios en [`openspec/`](openspec/)) solo cuando se pide explícitamente.
- Una decisión de arquitectura nueva se registra como ADR ([ADR-0001](docs/adr/0001-registrar-decisiones-con-adr.md)); no se edita un ADR aceptado, se enmienda o se reemplaza con otro.

## Comandos

```bash
pnpm install
pnpm check                          # lint, typecheck, depcruise y tests (los de DB usan Docker)
pnpm format:check                   # Prettier; pnpm format lo aplica
pnpm build:api                      # API y paquetes de los que depende
pnpm --filter @sifen/api start:dev  # API en :3000 (desarrollo)
pnpm --filter @sifen/web dev        # portal en :3001
pnpm --filter @sifen/api worker     # worker de transmisión
pnpm --filter @sifen/api ops <cmd>  # CLI de operación
pnpm --filter @sifen/db test:postgres
pnpm --filter @sifen/api coverage
```

Puesta en marcha completa: [`docs/desarrollo.md`](docs/desarrollo.md).

## Dónde encontrar

| Qué | Dónde |
|---|---|
| Producto y requisitos | [`docs/prd/prd.md`](docs/prd/prd.md) |
| Plan por fases | [`docs/roadmap.md`](docs/roadmap.md) |
| Historias del MVP | [`docs/backlog/mvp.md`](docs/backlog/mvp.md) |
| Decisiones de arquitectura | [`docs/adr/`](docs/adr/README.md) |
| Diseño técnico | [`docs/plan/plan-desarrollo-v1.1.md`](docs/plan/plan-desarrollo-v1.1.md) |
| API de integradores | `/docs` con la API en marcha; spec en [`docs/api/openapi.json`](docs/api/openapi.json); webhooks en [`docs/integracion/webhooks.md`](docs/integracion/webhooks.md) |
| Normativa DNIT | [`docs/referencia/`](docs/referencia/README.md) |
| Variables de entorno | [`docs/configuracion.md`](docs/configuracion.md) |
| Operación y CLI | [`docs/operacion.md`](docs/operacion.md) |
