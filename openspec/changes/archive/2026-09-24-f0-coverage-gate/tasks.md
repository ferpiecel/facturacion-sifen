# Tasks: Enforce an 85% test coverage gate in CI

- [x] 1. Confirm `@vitest/coverage-v8` version matching installed `vitest@5.0.1` (npm registry check).
- [x] 2. Add `@vitest/coverage-v8@5.0.1` devDependency to `packages/sifen-gateway`, `packages/sifen-tips`, `packages/sifen-xsd`, `apps/api`; `pnpm install` to update the lockfile.
- [x] 3. Measure current coverage per package (baseline, before thresholds).
- [x] 4. Add `coverage` config (v8 provider, `all: true`, 85% thresholds, justified excludes) to each package's `vitest.config.ts`.
- [x] 5. Close the one real gap found (`sifen-xsd` branch coverage on the non-libxml2 error path) with a genuine test.
- [x] 6. Add `coverage` script to each affected package's `package.json`.
- [x] 7. Add `coverage` task to `turbo.json` (`dependsOn: ["transit", "^build"]`, matching `test`).
- [x] 8. Add `coverage` to the CI quality-gates matrix in `.github/workflows/ci.yml`.
- [x] 9. Prove the gate fails on a real regression (temporarily removed a spec file, observed threshold error, reverted).
- [x] 10. Run the full gate list from a clean build (`format:check lint typecheck depcruise test build verify-vendor coverage`) and confirm all green.
