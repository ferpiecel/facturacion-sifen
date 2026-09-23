# Proposal: F0 Monorepo Foundation

## Intent

The repo is docs-only: no workspace, CI, or test runner. Every later epic needs a buildable monorepo, an enforced hexagonal layout (ADR-0003), and a runner so `strict_tdd` can be enabled. Success: CI runs lint, typecheck, dependency-cruiser, and tests green on a reference module.

## Scope

### In Scope
- HU-E0-01: pnpm workspaces + Turborepo root, Node 22 pinned (`engines` + `packageManager`/corepack), GitHub Actions CI.
- Shared `packages/config`: base tsconfig, ESLint flat config + typescript-eslint, Prettier.
- `.dependency-cruiser.cjs` encoding ADR-0003 layering.
- Workspace test runner: Vitest + `unplugin-swc`.
- HU-E0-03: `apps/api` NestJS + Fastify bootstrap with reference `health` module (domain/application/infrastructure, port + adapter, example tests).
- HU-E0-02 (PARTIAL): `docker-compose.yml` with Postgres 16 + Redis 7, `.env.example`. Story stays open.
- Flip `openspec/config.yaml` to `strict_tdd: true` with the verified test command.

### Out of Scope
- `apps/workers`, `apps/portal`, Drizzle schema, RLS, tenancy, SIFEN logic.
- MinIO (E3), SIFEN SOAP mock (HU-E0-05), module code generator.
- TS project references.

## Capabilities

### New Capabilities
- `monorepo-workspace`: workspace layout, Node/pnpm pinning, Turborepo tasks, shared config.
- `ci-pipeline`: GitHub Actions quality gates.
- `architecture-boundaries`: dependency-cruiser rules for hexagonal layering.
- `test-runner`: Vitest wiring with Nest decorator metadata support.
- `api-reference-module`: API bootstrap and canonical hexagonal `health` module.
- `local-dev-environment`: docker-compose Postgres + Redis.

### Modified Capabilities
- None

## Approach

| Decision | Choice | Rationale / ADR |
|---|---|---|
| Runtime | Node 22 LTS, TypeScript | ADR-0002 |
| Monorepo | pnpm + Turborepo | ADR-0004 |
| API | NestJS + Fastify, hexagonal inside `apps/api/src/modules/{bc}` | ADR-0003, plan §5 |
| Boundaries | dependency-cruiser: no `@nestjs/*`, `fastify`, `drizzle-orm`, `bullmq` in domain/application; domain -> app/infra and app -> infra forbidden | ADR-0003, ADR-0013 |
| Tests | Vitest + `unplugin-swc` | plan v1.1 §15.1 |
| Lint | ESLint + Prettier over Biome | Mature rule ecosystem; avoids later full reformat |
| TS config | Per-package extending shared base | Turborepo caches per task already |

Delivery (auto-chain, 400 lines/PR, lockfile excluded):
- **PR1**: root workspace, CI, lint, tsconfig, dependency-cruiser, docker-compose.
- **PR2**: Vitest, `apps/api` skeleton, `health` module, `strict_tdd` flip.

## Affected Areas

| Area | Impact |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc` | New |
| `.github/workflows/ci.yml` | New |
| `.dependency-cruiser.cjs` | New |
| `packages/config/` | New |
| `apps/api/` | New |
| `docker-compose.yml`, `.env.example` | New |
| `openspec/config.yaml` | Modified |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Vitest loses Nest decorator metadata | Med | `unplugin-swc`; Jest fallback |
| PR exceeds 400 lines | Med | Two chained PRs |
| HU-E0-02 marked done prematurely | Low | Explicit partial note in tasks/PR |
| Node 26 drops bundled corepack | Low | Revisit when leaving Node 22 |
| `.gitignore` needs Node entries but has unrelated uncommitted edits | Med | Stage only this change's hunks |

## Rollback Plan

All files are new except `openspec/config.yaml`. Revert PR2 (restores `strict_tdd: false`, removes `apps/api`), then PR1. No data, schema, or runtime state is affected. Unrelated uncommitted docs stay untouched.

## Dependencies

- GitHub Actions enabled on the repo; Docker available locally.

## Success Criteria

- [ ] `pnpm install && pnpm turbo run lint typecheck test` passes locally and in CI.
- [ ] dependency-cruiser fails on a `@nestjs/*` import in `domain/`.
- [ ] `health` module tests pass, including a DI-dependent test.
- [ ] `docker compose up` yields healthy Postgres 16 and Redis 7.
- [ ] `openspec/config.yaml` has `strict_tdd: true` and a real test command.
