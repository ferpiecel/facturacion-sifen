# Tasks: F0 Monorepo Foundation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~330, PR2 ~345 (lockfile excluded) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Workspace, tooling, CI, docker-compose | PR 1 | `pnpm install --frozen-lockfile && pnpm turbo run lint typecheck depcruise` | N/A — no runner yet in PR1 | Revert PR1; no runtime state |
| 2 | Vitest, `apps/api`, `health` module, strict_tdd flip | PR 2 | `pnpm turbo run test` | `docker compose up -d` + `pnpm --filter api start` then `curl :3000/health` | Revert PR2 (restores `strict_tdd: false`), keep PR1 |

## Phase 1: Workspace Foundation (PR1)

- [x] 1.1 Confirm pnpm 12.5.1 setting keys (`allowBuilds` vs `onlyBuiltDependencies`, `engineStrict`) against official pnpm docs before writing config. Verify: docs check, no command.
- [x] 1.2 Create root `package.json` (`engines`, `packageManager: pnpm@12.5.1`) and `.nvmrc` (`22`). Verify: `pnpm -v`.
- [x] 1.3 Create `pnpm-workspace.yaml` (`apps/*`, `packages/*`, confirmed settings from 1.1). Verify: `pnpm install --frozen-lockfile`.
- [x] 1.4 Create `turbo.json` (transit/build/lint/typecheck/depcruise/test/dev per design). Verify: `pnpm turbo run lint --dry`.
- [x] 1.5 Create `packages/config/{package.json, tsconfig.base.json, tsconfig.nest.json}`; document composition `tsconfig.base.json → tsconfig.nest.json → apps/api/tsconfig.json`. Verify: `tsc --showConfig -p packages/config/tsconfig.base.json`.
- [x] 1.6 Resolve exact `eslint-config-prettier` version via `npm view eslint-config-prettier version`, pin it, create `packages/config/eslint.config.js` (flat + `typescript-eslint` strictTypeChecked). Verify: `npx eslint --print-config packages/config/eslint.config.js`.
- [x] 1.7 Create `packages/config/prettier.config.js` (shared) and root `prettier.config.mjs` that re-exports it (root is the sole entry Prettier resolves; package config is the shared source). Verify: `pnpm exec prettier --check packages/config`.
- [x] 1.8 Create `.dependency-cruiser.cjs` with the 3 layering rules + `no-circular` per design. Verify: `pnpm exec depcruise --validate .dependency-cruiser.cjs`.

## Phase 2: CI & Local Dev (PR1)

- [x] 2.1 Create `.github/workflows/ci.yml`: confirm trigger scope is `push` to `main` + `pull_request` (matches spec `ci-pipeline`); matrix jobs lint/typecheck/depcruise/test; corepack + setup-node + `actions/cache@v6`. Verify: `actionlint .github/workflows/ci.yml`.
- [x] 2.2 Create `docker-compose.yml` (`postgres:16-alpine`, `redis:7-alpine`, healthchecks, named volumes). Verify: `docker compose config`.
- [ ] 2.3 Create `.env.example` (placeholders only, no secrets). Verify: manual review. **BLOCKED**: sandbox permission system denies any write to this exact path; needs manual creation or a permission grant (see apply-progress.md for content).
- [x] 2.4 Update `.gitignore`: add `.turbo/`, `coverage/`, `*.tsbuildinfo` via `git add -p`, staging only this change's hunks (leave pre-existing unrelated hunks untouched). Verify: `git diff --staged .gitignore`.
- [x] 2.5 Create `.prettierignore` (`docs/`, `openspec/`, lockfile). Verify: `pnpm exec prettier --check .`.
- [ ] 2.6 Commit PR1 as scoped work-unit commits; open PR1 targeting `main`. Verify: `pnpm install --frozen-lockfile && pnpm turbo run lint typecheck depcruise`. **PARTIAL**: 4 work-unit commits made and verified on `feat/f0-workspace-foundation`; push rejected (`gh` token missing `workflow` scope, required because the diff touches `.github/workflows/ci.yml`). PR not yet opened.

## Phase 3: Test Runner Setup (PR2)

- [x] 3.1 Create `apps/api/{package.json, tsconfig.json (extends tsconfig.nest.json), tsconfig.build.json, eslint.config.js, vitest.config.ts (unplugin-swc)}`. Verify: `pnpm --filter api typecheck`.
- [x] 3.2 Create `test/fixtures/boundaries/modules/sample/{domain,application,infrastructure}/*.ts` (6 files: one per forbidden rule + one allowed infra→application import).
- [x] 3.3 RED: write `test/architecture/boundaries.spec.ts` asserting the 3 layering violations and that the allowed import is not flagged. Verify: `pnpm --filter api test test/architecture/boundaries.spec.ts` fails.
- [x] 3.4 GREEN: wire `.dependency-cruiser.cjs` rules against fixtures. Verify: same command passes.

## Phase 4: API Reference Module — `health` (PR2, TDD red→green)

- [x] 4.1 RED: write `application/get-health.use-case.spec.ts` (fake port). Verify: fails (no source).
- [x] 4.2 GREEN: create `domain/health-report.ts`, `application/ports/health-check.port.ts`, `application/get-health.use-case.ts`. Verify: spec passes.
- [x] 4.3 RED: write `infrastructure/health.module.spec.ts` (DI: `Test.createTestingModule` resolves `HealthCheckPort`). Verify: fails.
- [x] 4.4 GREEN: create `infrastructure/adapters/process-health-check.adapter.ts`, `infrastructure/controllers/health.controller.ts`, `src/modules/health/{health.module.ts, health.tokens.ts}`. Verify: DI spec passes.
- [x] 4.5 RED: write `test/health.e2e.spec.ts` (`GET /health` → 200 via Fastify `inject()`). Verify: fails.
- [x] 4.6 GREEN: create `src/main.ts`, `src/app.module.ts` wiring `HealthModule`. Verify: e2e spec passes.

## Phase 5: Finalize (PR2)

- [x] 5.1 Run `pnpm turbo run lint typecheck depcruise test build`; confirm all gates green. Verify: same command, exit 0.
- [x] 5.2 Flip `openspec/config.yaml`: `strict_tdd: true`, `apply.tdd: true`, `apply.test_command`/`verify.test_command: "pnpm turbo run test"`, `verify.build_command: "pnpm turbo run build"`. Verify: file inspection matches spec `test-runner`.
- [x] 5.3 Commit PR2 as scoped work-unit commits; open PR2 targeting PR1's branch (stacked-to-main); confirm diff excludes PR1 content. Verify: `git diff <PR1-branch>...HEAD --stat`.
