# Design: F0 Monorepo Foundation

## Technical Approach

A pnpm + Turborepo workspace (ADR-0004) with one shared package, `@sifen/config`, and one app, `@sifen/api`. The app runs NestJS 12 + Fastify (ADR-0003) as native ESM and is compiled by `tsc` (TypeScript 6). Its reference `health` module follows plan §5. dependency-cruiser enforces layering, and a Vitest test proves each rule on fixtures. CI runs one matrix job per quality gate. Each spec under `specs/*` maps to a section below.

## Pinned Versions (verified against the npm registry on 2026-09-23)

| Tool | Version | Tool | Version |
|---|---|---|---|
| Node | 22.23.2 (`.nvmrc` `22`, `engines` `>=22.12.0 <23`) | pnpm | 12.5.1 (`packageManager: "pnpm@12.5.1"`) |
| turbo | 2.11.3 | typescript | 6.0.3 |
| vitest | 5.0.1 | unplugin-swc / @swc/core | 2.0.0 / 1.16.2 |
| dependency-cruiser | 18.4.0 | eslint / typescript-eslint | 10.11.0 / 8.70.1 |
| prettier | 3.9.9 | @nestjs/{core,common,platform-fastify,testing} | 12.1.0 |
| GitHub Actions | `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6` | | |

**Apply-time verification (pnpm 12 settings syntax).** Put pnpm settings in `pnpm-workspace.yaml`, not `.npmrc`: recent pnpm majors read pnpm-specific settings only from the workspace file. Settings:

- **Engine check:** `engineStrict: true`.
- **Build-script allow-list:** `@swc/core` and `esbuild`. Use `allowBuilds: { "@swc/core": true, esbuild: true }` if pnpm 12 uses that key. Otherwise use the legacy `onlyBuiltDependencies`.

The executor confirms both key names against the pnpm 12 docs before writing the file.

## Architecture Decisions

| Topic | Choice | Rejected | Rationale |
|---|---|---|---|
| Package scope | `@sifen/*` (`private: true`) | `@repo/*`, `@facturacion-sifen/*` | Short and project-specific. The packages are never published. `pnpm --filter api` still resolves the unique name. |
| TypeScript | 6.0.x | 7.x (Go port) | `typescript-eslint` 8.70.1 requires peer `typescript >=4.8.4 <6.1.0`. TS 7 ships no programmatic compiler API, which breaks typed linting, `nest build`, and the Swagger CLI plugins. Revisit when typescript-eslint supports TS 7. |
| Module system | **ESM**: `apps/api` sets `"type": "module"`; `module`/`moduleResolution: nodenext`; relative imports end in `.js` | CJS | Every `@nestjs/*` 12.x package publishes `"type": "module"`. Native ESM also lets tests import dependency-cruiser 18 statically. |
| ESM + decorator metadata | 1) `no-circular` is an **error** in dependency-cruiser. 2) Use `forwardRef()` only for any unavoidable cycle. 3) Injected classes are **value** imports; `import type` is only for non-injected types. 4) `consistent-type-imports` stays **off**. | Laissez-faire | With emitted `design:paramtypes`, an imported class is referenced when the module is evaluated. An ESM cycle then throws a TDZ `ReferenceError`. A type-only import of an injected class silently emits `Object`, and injection fails. The DI test catches that. |
| TS config | `tsconfig.base.json` (strict, `types: ["node"]` explicit, `isolatedModules`, `verbatimModuleSyntax`) + `tsconfig.nest.json` (nodenext, `experimentalDecorators`, `emitDecoratorMetadata`) | One shared base | The future `apps/portal` must not inherit Nest settings. The explicit `types` is needed because TS 6 defaults `types` to `[]`. `verbatimModuleSyntax` makes import elision predictable for SWC. |
| Build | `tsc -p tsconfig.build.json` | Nest CLI / `nest build` | Fewer dependencies. SWC is used **only** inside Vitest. |
| Lint | ESLint 10 flat config + `typescript-eslint` `strictTypeChecked` + `eslint-config-prettier`; `no-extraneous-class: { allowWithDecorator: true }` | Biome | Proposal decision. Empty `@Module` classes are idiomatic in Nest. |
| Tests | Vitest 5 + `unplugin-swc` (`swc.vite({ module: { type: 'es6' } })`), `vitest.config.ts` | Jest | Plan §15.1. SWC keeps decorator metadata. |
| Port location | `application/ports/` | `domain/ports/` | Required by spec `api-reference-module`. `domain/` holds value types only. |
| Boundary proof | A Vitest test that calls the dependency-cruiser API in-process on fixtures | A shell script checking the CLI exit code | No subprocess. Each rule is asserted by name. |
| CI topology | Matrix over `lint`, `typecheck`, `depcruise`, `test`, `build` | One sequential job | Spec `ci-pipeline` requires each gate to report separately. |
| Toolchain setup | `setup-node` (`node-version-file: .nvmrc`) → `corepack enable` → `actions/cache` on `pnpm store path`, keyed by `hashFiles('pnpm-lock.yaml')` | `pnpm/action-setup` | Spec `ci-pipeline` requires corepack. |
| Turbo cache busting | A `transit` task, plus `globalDependencies: [".dependency-cruiser.cjs"]` | Rely on `^build` | `@sifen/config` has no build step. Without this, its edits would not invalidate cached lint or typecheck results in the packages that use it. |

## Data Flow

```
GET /health → HealthController (infra, @Controller)
               └→ GetHealthUseCase (application, plain class, built by useFactory)
                    └→ HealthCheckPort ◄─ ProcessHealthCheckAdapter (infra, @Injectable)
               ← HealthReport (domain) → 200 { status: "up", uptimeSeconds, checkedAt } | 503 when down
```

## File Changes

Every file is new except the two marked (M).

| PR | Files |
|---|---|
| PR1 (~330 lines) | `package.json`, `pnpm-workspace.yaml` (packages plus pnpm settings), `turbo.json`, `.nvmrc`, `.prettierignore` (`docs/`, `openspec/`, lockfile), `prettier.config.mjs`, `.gitignore` (M: add `.turbo/`, `coverage/`, `*.tsbuildinfo`; stage only these hunks), `packages/config/{package.json, tsconfig.base.json, tsconfig.nest.json, eslint.config.js, prettier.config.js}`, `.dependency-cruiser.cjs`, `.github/workflows/ci.yml`, `docker-compose.yml`, `.env.example` |
| PR2 (~345 lines) | `apps/api/{package.json, tsconfig.json, tsconfig.build.json, eslint.config.js, vitest.config.ts}`, `src/{main.ts, app.module.ts}`, `src/modules/health/{health.module.ts, health.tokens.ts}`, `domain/health-report.ts`, `application/{ports/health-check.port.ts, get-health.use-case.ts, get-health.use-case.spec.ts}`, `infrastructure/{adapters/process-health-check.adapter.ts, controllers/health.controller.ts, health.module.spec.ts}`, `test/{health.e2e.spec.ts, architecture/boundaries.spec.ts}`, `test/fixtures/boundaries/modules/sample/{domain,application,infrastructure}/*.ts` (6 small files), `openspec/config.yaml` (M) |

Line counts exclude the lockfile. Moving to ESM adds only the `.js` suffixes and `"type": "module"`, so the estimates barely change. In PR1, the `depcruise` and `test` jobs have nothing to run yet.

## Interfaces / Contracts

`turbo.json`:

```json
{ "globalDependencies": [".dependency-cruiser.cjs"],
  "tasks": {
    "transit":   { "dependsOn": ["^transit"] },
    "build":     { "dependsOn": ["^build"], "inputs": ["$TURBO_DEFAULT$", "!**/*.spec.ts", "!test/**"], "outputs": ["dist/**"] },
    "lint":      { "dependsOn": ["transit"] },
    "typecheck": { "dependsOn": ["transit"] },
    "depcruise": { "dependsOn": ["transit"] },
    "test":      { "dependsOn": ["transit"] },
    "dev":       { "cache": false, "persistent": true } } }
```

**Root scripts:**

- `build`, `lint`, `typecheck`, `test`, `depcruise`: each runs `turbo run <task>`.
- `check`: runs all of the above.
- `format` / `format:check`: Prettier. The `lint` CI job runs `format:check`.

**`apps/api` scripts:**

- `build`: `tsc -p tsconfig.build.json`
- `typecheck`: `tsc --noEmit`
- `lint`: `eslint .`
- `test`: `vitest run`
- `depcruise`: `depcruise src --config ../../.dependency-cruiser.cjs`
- `start`: `node dist/main.js`

**`.dependency-cruiser.cjs`.** Options: `tsPreCompilationDeps: true` (type-only imports count) and `doNotFollow: node_modules`. The config file stays `.cjs` because the repo root is not `"type": "module"`.

```js
const FW = '(^|node_modules/)((@nestjs|@fastify)/|(fastify|drizzle-orm|bullmq|ioredis|pg|reflect-metadata)(/|$))';
forbidden: [
  { name: 'domain-app-framework-free', severity: 'error',
    from: { path: '(^|/)modules/[^/]+/(domain|application)/' }, to: { path: FW } },
  { name: 'domain-no-outer-layers', severity: 'error',
    from: { path: '(^|/)modules/[^/]+/domain/' }, to: { path: '(^|/)modules/[^/]+/(application|infrastructure)/' } },
  { name: 'application-no-infrastructure', severity: 'error',
    from: { path: '(^|/)modules/[^/]+/application/' }, to: { path: '(^|/)modules/[^/]+/infrastructure/' } },
  { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
]
```

`FW` matches both resolved pnpm paths and unresolved bare names (the fixtures).

**`boundaries.spec.ts`:**

- Statically imports `cruise` from `dependency-cruiser`.
- Loads the root rule set with `createRequire(import.meta.url)`.
- Cruises `test/fixtures/boundaries` and asserts that each of the three layering rules is violated.
- Asserts that the allowed `infrastructure → application` import is **not** flagged.

The depcruise CLI exits non-zero when any error-severity violation exists.

**Health wiring.** `health.tokens.ts` exports `HEALTH_CHECK_PORT = Symbol('HealthCheckPort')`. The module registers two providers:

- `{ provide: HEALTH_CHECK_PORT, useClass: ProcessHealthCheckAdapter }`
- `{ provide: GetHealthUseCase, useFactory: (p) => new GetHealthUseCase(p), inject: [HEALTH_CHECK_PORT] }`

`main.ts` uses top-level `await` for `NestFactory.create(AppModule, new FastifyAdapter())` and `listen(PORT ?? 3000, '0.0.0.0')`.

**CI (`.github/workflows/ci.yml`):**

- Triggers: `push` to `main`, and `pull_request`.
- `permissions: contents: read`; concurrency cancels in-progress runs; runner `ubuntu-24.04`.
- Install with `pnpm install --frozen-lockfile`.
- `actions/cache@v6` caches `.turbo/cache` with key `turbo-${{ matrix.task }}-${{ github.sha }}` and a prefix restore key.

**docker-compose:**

- Services: `postgres:16-alpine` and `redis:7-alpine` (`--appendonly yes`), with named volumes `pgdata` and `redisdata`.
- Healthchecks: `pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}` and `redis-cli ping`, interval 5s, 10 retries.
- Variables use `${VAR:-default}`, so no `.env` file is needed.
- `.env.example` holds placeholder values for `POSTGRES_*`, `DATABASE_URL`, `REDIS_*`, `PORT`, and `NODE_ENV`.

**`openspec/config.yaml` (PR2):**

- `strict_tdd: true` and `apply.tdd: true`.
- `apply.test_command` and `verify.test_command`: `pnpm turbo run test`.
- `verify.build_command`: `pnpm turbo run build`.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `GetHealthUseCase` | Pure Vitest with a fake port |
| DI | The port resolves to the adapter, and controller constructor injection works | `Test.createTestingModule({ imports: [HealthModule] })`. This proves SWC emits metadata under ESM. |
| HTTP | `GET /health` → 200 | `FastifyAdapter`, then `app.init()`, then Fastify `inject()` |
| Architecture | The three layering rules, plus the allowed direction | `boundaries.spec.ts` on the fixtures. Real `src` must have 0 violations. |
| Env | Compose health | Manual `docker compose ps` (not run in CI) |

## Threat Matrix

N/A. There is no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. CI is read-only (`contents: read`), and the boundary test runs in-process.

## Migration / Rollout

No migration is required. Revert PR2, then PR1. Leave the unrelated uncommitted edits in `README.md`, `.gitignore`, and `docs/referencia/` untouched.

## Open Questions

- [ ] pnpm 12 key names (`allowBuilds` vs `onlyBuiltDependencies`, `engineStrict`): confirm at apply time.
- [ ] Coverage gate (≥85% for domain/application, plan §15.1): deferred.
- [ ] Rule for imports across bounded contexts: deferred until a second module exists.
