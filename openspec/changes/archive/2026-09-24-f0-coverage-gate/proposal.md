# Proposal: Enforce an 85% test coverage gate in CI

## Intent

`docs/plan/plan-desarrollo-v1.1.md` §15.1 sets a ≥85% Vitest coverage target for `domain/` and `application/` code, but nothing in CI enforces it today. This change wires `@vitest/coverage-v8` into every package that has tests, sets an 85% threshold (lines/branches/functions/statements) on published package code, and adds a `coverage` gate to the CI matrix so a regression fails the build instead of silently shipping.

## Scope

### In Scope
- Add `@vitest/coverage-v8@5.0.1` (matching the installed `vitest@5.0.1`) as a devDependency to `packages/sifen-gateway`, `packages/sifen-tips`, `packages/sifen-xsd`, `apps/api`.
- Configure `coverage` (`provider: 'v8'`, `all: true`, thresholds 85%) in each package's `vitest.config.ts`, scoped to `src/**` and excluding test files, `.d.ts` output, CLI scripts, and the process bootstrap entrypoint.
- Add one real test to `packages/sifen-xsd` closing a branch gap uncovered by existing tests (error-normalization fallback path).
- Add a `coverage` task to `turbo.json` (same `dependsOn` shape as `test`) and a `coverage` script to each affected package.
- Add `coverage` to the CI quality-gates matrix in `.github/workflows/ci.yml`.

### Out of Scope
- Raising coverage on maintainer-only CLI scripts (`packages/sifen-xsd/scripts/**`); excluded with a documented rationale.
- Any change to test content beyond the one gap-closing test needed to meet the new gate.
- `packages/config`, which has no tests and no `test`/`coverage` script.

## Capabilities

### Modified Capabilities
- `ci-pipeline`: add a coverage-gate requirement.

## Approach

Use Vitest's built-in v8 coverage provider (no separate Istanbul toolchain) with `all: true` so untested files count against the gate instead of being silently skipped. Exclusions are narrow and commented: bootstrap entrypoints, CLI scripts, test fixtures/support files, and `.d.ts` output — never domain/application logic. Where a real gap existed (`sifen-xsd` branch coverage), it was closed with a genuine behavioral test, not a lowered threshold.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/*/vitest.config.ts`, `apps/api/vitest.config.ts` | Modified | Coverage provider + 85% thresholds |
| `packages/*/package.json`, `apps/api/package.json` | Modified | `@vitest/coverage-v8` devDependency + `coverage` script |
| `packages/sifen-xsd/test/validate-xml.spec.ts` | Modified | New test closing a branch-coverage gap |
| `turbo.json` | Modified | New `coverage` task |
| `.github/workflows/ci.yml` | Modified | `coverage` added to the quality-gates matrix |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Threshold too strict for future low-signal files | Low | Exclusions are narrow and reviewed per-PR; not a blanket opt-out |
| CI slower with coverage instrumentation | Low | v8 native coverage; measured overhead is sub-second per package |

## Rollback Plan

Revert this change: removes the `coverage` task from `turbo.json` and the CI matrix, and the `coverage` config blocks from each `vitest.config.ts`. No runtime or data impact.

## Success Criteria

- [x] `@vitest/coverage-v8@5.0.1` installed and pinned to match `vitest@5.0.1` exactly.
- [x] Every tested package meets an 85% threshold on lines/branches/functions/statements for its non-excluded code.
- [x] CI fails when a package's coverage drops below 85% (proven manually, not just asserted).
- [x] No threshold was lowered to make a package pass; the one real gap found was closed with a real test.
