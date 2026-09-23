# Exploration: F0 monorepo foundation

Scope evaluated: HU-E0-01 (monorepo + CI), HU-E0-03 (hexagonal module template), workspace test runner, HU-E0-02 (docker-compose) evaluated for fit.

## Current State

Repo is documentation-only: no `package.json`, no source tree, no CI config. `openspec/config.yaml` fixes the intended stack from accepted ADRs: Node.js 22 + TypeScript, NestJS + Fastify adapter, hexagonal `domain/`/`application/` (framework-free, `dependency-cruiser`-enforced), pnpm workspaces + Turborepo (`apps/api`, `apps/workers`, `apps/portal`, `packages/*`), PostgreSQL 16 + Drizzle + FORCE RLS, BullMQ + Redis 7. `strict_tdd: false`, pending this change's test runner.

Already decided by docs (not open questions):

- `docs/plan/plan-desarrollo-v1.1.md` §15.1 names **Vitest** for domain/application unit tests (≥85%) and Testcontainers for integration.
- §4 (stack table) names **GitHub Actions** for CI/CD.
- §5 places the hexagonal module layout (`src/modules/{bc}/domain|application|infrastructure`) *inside* `apps/api`, not as separate pnpm packages. Layering is enforced by `dependency-cruiser`, not workspace boundaries.

## Affected Areas (to be created)

- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`/`engines`, `.gitignore` — workspace root (HU-E0-01)
- `.github/workflows/ci.yml` — lint/typecheck/test/dependency-cruiser gate (HU-E0-01)
- `.dependency-cruiser.cjs` — layering rules expressing ADR-0003
- `packages/config/` — shared tsconfig/eslint/vitest base (ADR-0004 naming)
- `apps/api/` — NestJS+Fastify skeleton, one reference hexagonal module (`health`), `vitest.config.ts`
- `docker-compose.yml`, `.env.example` — HU-E0-02 (partial)
- `openspec/config.yaml` — flip `strict_tdd: true` and set `test_command` once the runner is verified

## Approaches

| Topic | Options | Recommendation |
|---|---|---|
| Test runner | Vitest vs Jest | **Vitest** (fixed by plan §15.1). Requires `unplugin-swc` so Nest DI keeps `emitDecoratorMetadata`. Jest is the fallback only if SWC wiring proves unworkable. |
| Lint/format | ESLint flat config + typescript-eslint + Prettier vs Biome | **ESLint + Prettier**. Only genuinely open fork; mature rule ecosystem outweighs Biome's speed at this size, and switching later forces a full reformat. |
| TS config | Project references vs per-package `tsconfig.json` extending a shared base | **Per-package + shared base**; Turborepo already caches per task. Revisit when packages multiply. |
| HU-E0-02 | Full compose vs partial | **Postgres 16 + Redis 7 only**. MinIO lands with HU-E3, SIFEN SOAP mock with HU-E0-05. |
| HU-E0-03 generator | Code-generator CLI vs reference module | **Reference module + example test** satisfies the acceptance criteria; generator deferred. |

## Recommended Shape

- pnpm workspaces + Turborepo; Node 22 pinned via `engines` + `packageManager` (corepack).
- GitHub Actions CI: lint, typecheck, `dependency-cruiser`, test.
- `.dependency-cruiser.cjs` encoding ADR-0003: no `@nestjs/*` (or other framework/infra libs) in `domain/`/`application/`; `domain/` cannot import `application/` or `infrastructure/`; `application/` cannot import `infrastructure/`.
- ESLint flat config + Prettier shared from `packages/config`.
- Vitest root + per-package config, SWC transform in `apps/api`.
- `apps/api`: NestJS+Fastify bootstrap and a `health` module with the canonical `domain/application/infrastructure` folders, one port + adapter + test.
- `docker-compose.yml` with Postgres 16 + Redis 7.

## Size and PR Split

Estimated 350–450 authored lines (lockfile excluded) → budget risk Medium as one PR. With `auto-chain`:

- **PR1 (HU-E0-01 core):** root workspace, CI, dependency-cruiser, ESLint/Prettier, base tsconfig, docker-compose.
- **PR2 (HU-E0-03 + test runner):** Vitest wiring, `apps/api` skeleton, reference `health` module with tests.

## Risks

- Vitest + Nest decorator metadata needs `unplugin-swc`.
- Node 26 drops bundled corepack; revisit pinning when leaving Node 22 LTS.
- HU-E0-02 only partially delivered; do not mark the story done.
- `strict_tdd` flip only after the runner is verified.

## Ready for Proposal

Yes.
