# Apply Progress: f0-sifen-gateway-fake

## Scope this batch

Phases 1–2 only (scaffolding + types/codes/errors/port), per orchestrator instruction. Phases 3–5 remain pending for a future batch.

## Mode

Strict TDD (per `openspec/config.yaml` and orchestrator instruction).

## TDD Cycle Evidence

| Task | RED (failing line) | RED commit | GREEN commit |
|---|---|---|---|
| 2.1/2.2 codes | `Cannot find module '../src/codes.ts' imported from .../test/codes.spec.ts` at `test/codes.spec.ts:2:1` | `e6efd3c` | `ed40aae` |
| 2.3/2.4 types | `Cannot find module '../src/types.ts' imported from .../test/types.spec.ts` at `test/types.spec.ts:2:1` | `415863e` | `9984f9c` |
| 2.5/2.6 errors | `Cannot find module '../src/errors.ts' imported from .../test/errors.spec.ts` at `test/errors.spec.ts:2:1` | `2ac9b06` | `532be5a` |
| 2.7 port | (interface/type-only, no test) | — | `510f785` |

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and result | `npx --yes pnpm@12.5.1 --filter @sifen/sifen-gateway test` → 3 files, 7 tests passed |
| Runtime harness | N/A — pure unit/type-level package, no external system boundary in this batch |
| Rollback boundary | Revert commits `ab9a359`..`f0ab08e`; no consumers exist yet |

## Completed Tasks

### Phase 1: Scaffolding (PR 1)
- [x] 1.1 Package scaffolding (`package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`)
- [x] 1.2 `src/index.ts` empty barrel (later wired with real exports in 2.7)
- [x] 1.3 Verify: `pnpm --filter @sifen/sifen-gateway build` — passed

### Phase 2: Types, codes, errors (TDD, PR 1)
- [x] 2.1 RED `test/codes.spec.ts`
- [x] 2.2 GREEN `src/codes.ts` (`SIFEN_CODES`, `SifenCode`)
- [x] 2.3 RED `test/types.spec.ts`
- [x] 2.4 GREEN `src/types.ts` (`Cdc`, `toCdc`, result types)
- [x] 2.5 RED `test/errors.spec.ts`
- [x] 2.6 GREEN `src/errors.ts` (`SifenTimeoutError`, `SifenTransportError`)
- [x] 2.7 `src/port.ts` (`SifenGateway`, `SifenOperation`, `SifenResultOf<K>`, `SifenCall`); barrel wired
- [x] 2.8 Verify: `test && typecheck` — passed

## Files Changed

| File | Action |
|---|---|
| `packages/sifen-gateway/package.json` | Created |
| `packages/sifen-gateway/tsconfig.json` | Created |
| `packages/sifen-gateway/tsconfig.build.json` | Created |
| `packages/sifen-gateway/eslint.config.js` | Created |
| `packages/sifen-gateway/vitest.config.ts` | Created |
| `packages/sifen-gateway/src/index.ts` | Created, then wired as barrel |
| `packages/sifen-gateway/src/codes.ts` | Created |
| `packages/sifen-gateway/src/types.ts` | Created |
| `packages/sifen-gateway/src/errors.ts` | Created |
| `packages/sifen-gateway/src/port.ts` | Created |
| `packages/sifen-gateway/test/codes.spec.ts` | Created |
| `packages/sifen-gateway/test/types.spec.ts` | Created |
| `packages/sifen-gateway/test/errors.spec.ts` | Created |
| `pnpm-lock.yaml` | Regenerated (new workspace member) |

## Deviations from Design

- `dId: bigint` field placement and per-operation request shapes are not specified verbatim in the read scope (design/spec reference "the plan" for exact names, which was out of read scope). Modeled each `SifenGateway` method as taking a single request object `{ dId: bigint; ...payload }`, matching the design's `SifenCall`/`Parameters<SifenGateway[K]>` shape. Flag for verify/plan cross-check.
- `errors.ts` type-only imports `SifenOperation` from `port.ts`, created one task later (2.7) — valid because it's a type-only import erased at runtime; `tsc --noEmit` in 2.8 (run after port.ts existed) confirms no type error.

## Issues Found

- Initial format:check (`turbo run format:check`) flagged `src/index.ts` and `src/port.ts`; fixed with `prettier --write` and committed as `f0ab08e style(sifen-gateway): apply prettier formatting`.
- `pnpm install --frozen-lockfile` failed until `pnpm install --lockfile-only` regenerated `pnpm-lock.yaml` for the new workspace member.

## Remaining Tasks

- [ ] Phase 3: Framework-isolation boundary (tasks 3.1–3.5)
- [ ] Phase 4: Fake gateway (tasks 4.1–4.4)
- [ ] Phase 5: CI wiring and close-out (tasks 5.1–5.2)

## Workload / PR Boundary

- Mode: stacked-to-main (chain strategy from tasks.md forecast)
- Current work unit: Unit 1 (Port, types, codes, errors) — PR 1, partial (Phase 3 boundary check still pending)
- Boundary: this batch starts from empty `packages/sifen-gateway` and ends with a typechecked, tested port + types + codes + errors, barrel wired
- Estimated review budget impact: 13 files changed, 314 insertions(+), well under 400-line budget

## Verification (this batch)

- RED `codes`: `Cannot find module '../src/codes.ts' imported from .../test/codes.spec.ts` at `test/codes.spec.ts:2:1` → red commit `e6efd3c`
- RED `types`: `Cannot find module '../src/types.ts' imported from .../test/types.spec.ts` at `test/types.spec.ts:2:1` → red commit `415863e`
- RED `errors`: `Cannot find module '../src/errors.ts' imported from .../test/errors.spec.ts` at `test/errors.spec.ts:2:1` → red commit `2ac9b06`
- GREEN: `npx --yes pnpm@12.5.1 --filter @sifen/sifen-gateway test` → 3 test files, 7 tests passed
- `npx --yes pnpm@12.5.1 turbo run format:check lint typecheck depcruise test build` → 19/19 tasks successful
- `git log --oneline main..HEAD` → 10 commits (ab9a359..f0ab08e)
- `git diff main...HEAD --shortstat -- . ':(exclude)pnpm-lock.yaml' ':(exclude)openspec'` → 13 files changed, 314 insertions(+)

## Batch 2: Phase 3 (Framework-isolation boundary)

### Deviation: `--base-dir` does not exist

`dependency-cruiser@18.4.0`'s CLI has no `--base-dir` option (confirmed via `depcruise --help`). Applied the documented fallback instead: `packages/sifen-gateway/.dependency-cruiser.cjs` that `extends: '../../.dependency-cruiser.cjs'` and adds a local-scoped rule `sifen-gateway-framework-free-local` (`from: '^src/'`) alongside the unchanged root rule `sifen-gateway-framework-free` (`from: '(^|/)packages/sifen-gateway/src/'`, matches when cruised from repo root, e.g. via the architecture boundary test). Package script updated: `depcruise --config .dependency-cruiser.cjs src`.

### TDD Cycle Evidence

| Task | RED (failing line) | RED commit | GREEN commit |
|---|---|---|---|
| 3.3 boundaries.spec | `AssertionError: expected [] to include 'sifen-gateway-framework-free'` at `boundaries.spec.ts:83:7` (root rule temporarily removed to prove the assertion catches a missing rule; rule was already committed in `a2a38c1` per task order 3.1→3.3) | `576675b` | (already passing on restore; see 3.4 below) |
| 3.4 base-dir wiring | `error sifen-gateway-framework-free-local: src/port.ts → @nestjs/common` when running `pnpm --filter @sifen/sifen-gateway depcruise` with a temporary `import '@nestjs/common'` added to `src/port.ts` (reverted, not committed) | N/A (config fix) | `fe78e09` |

### Completed Tasks

- [x] 3.1 Root rule `sifen-gateway-framework-free` — commit `a2a38c1`
- [x] 3.2 Fixture `apps/api/test/fixtures/boundaries/packages/sifen-gateway/src/framework-import.ts`
- [x] 3.3 RED boundary spec case — commit `576675b`
- [x] 3.4 GREEN: package-local `.dependency-cruiser.cjs` fallback + package.json script — commit `fe78e09`
- [x] (fixup) prettier formatting on `boundaries.spec.ts` — commit `a082ab4`
- [x] (fixup) eslint ignore for the new `.dependency-cruiser.cjs` (plain CJS, no parser project) — commit `2b7eb6d`
- [x] 3.5 Verify: `pnpm --filter @sifen/api test -- boundaries.spec.ts` — 5 test files, 22 tests passed

### Files Changed (this batch)

| File | Action |
|---|---|
| `.dependency-cruiser.cjs` | Added `sifen-gateway-framework-free` rule |
| `apps/api/test/fixtures/boundaries/packages/sifen-gateway/src/framework-import.ts` | Created |
| `apps/api/test/architecture/boundaries.spec.ts` | New test case |
| `packages/sifen-gateway/.dependency-cruiser.cjs` | Created (local fallback config) |
| `packages/sifen-gateway/package.json` | `depcruise` script uses local config |
| `packages/sifen-gateway/eslint.config.js` | Ignore `.dependency-cruiser.cjs` |

### Verification (this batch)

- RED: `AssertionError: expected [] to include 'sifen-gateway-framework-free'` at `boundaries.spec.ts:83:7`; red commit `576675b`
- GREEN: `pnpm --filter @sifen/api test -- boundaries.spec.ts` → 5 test files, 22 tests passed
- End-to-end proof: temporary `import '@nestjs/common'` in `packages/sifen-gateway/src/port.ts` + `pnpm --filter @sifen/sifen-gateway depcruise` → `error sifen-gateway-framework-free-local: src/port.ts → @nestjs/common`; reverted (not committed), re-ran depcruise clean
- `pnpm turbo run format:check lint typecheck depcruise test build` → 19/19 tasks successful
- `git diff main...HEAD --shortstat -- . ':(exclude)pnpm-lock.yaml' ':(exclude)openspec'` → 17 files changed, 353 insertions(+)

### Remaining Tasks

- [ ] Phase 4: Fake gateway (tasks 4.1–4.4)
- [ ] Phase 5: CI wiring and close-out (tasks 5.1–5.2)
