# Tasks: SIFEN gateway port and in-process fake

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~330, PR2 ~370 |
| 400-line budget risk | Low (per PR) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (scaffold, port, types, codes, errors, depcruise rule, boundary test) → PR 2 (fake + scenarios, stacked on PR 1) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Port, types, codes, errors, depcruise rule, boundary test | PR 1 | `pnpm --filter @sifen/sifen-gateway test` | `pnpm --filter @sifen/sifen-gateway depcruise` | revert PR 1 squash commit; no consumers exist |
| 2 | `FakeSifenGateway` + scenarios | PR 2 | `pnpm --filter @sifen/sifen-gateway test` | N/A — pure in-process fake, no external system | revert PR 2 squash commit only |

## Phase 1: Scaffolding (PR 1)

- [x] 1.1 Create `packages/sifen-gateway/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js,vitest.config.ts}` mirroring `packages/sifen-xsd` conventions (nodenext, erasableSyntaxOnly, pinned devDependencies).
- [x] 1.2 Add `src/index.ts` empty barrel so the package builds.
- [x] 1.3 Verify: `pnpm --filter @sifen/sifen-gateway build`.

## Phase 2: Types, codes, errors (TDD, PR 1)

- [x] 2.1 RED: write `test/codes.spec.ts` asserting `SIFEN_CODES` exact values; run, capture failing line, commit alone as `test(sifen-gateway): add codes catalog spec (red)`.
- [x] 2.2 GREEN: implement `src/codes.ts` (`SIFEN_CODES` as const, `SifenCode`); commit `feat(sifen-gateway): add verified code catalog`.
- [x] 2.3 RED: write `test/types.spec.ts` for `toCdc` (accepts 44 digits, rejects others); run, capture failing line, commit `test(sifen-gateway): add types spec (red)`.
- [x] 2.4 GREEN: implement `src/types.ts` (`Cdc`, `toCdc`, result types); commit `feat(sifen-gateway): add result types and Cdc`.
- [x] 2.5 RED: write `test/errors.spec.ts` (`instanceof`, `name`, `operation`, `cause`); run, capture failing line, commit `test(sifen-gateway): add errors spec (red)`.
- [x] 2.6 GREEN: implement `src/errors.ts` (`SifenTimeoutError`, `SifenTransportError`); commit `feat(sifen-gateway): add typed gateway errors`.
- [x] 2.7 Add `src/port.ts` (`SifenGateway`, `SifenOperation`, `SifenResultOf<K>`); wire barrel `src/index.ts`; commit `feat(sifen-gateway): add SifenGateway port`.
- [x] 2.8 Verify: `pnpm --filter @sifen/sifen-gateway test && pnpm --filter @sifen/sifen-gateway typecheck`.

## Phase 3: Framework-isolation boundary (TDD, PR 1)

- [x] 3.1 Add root rule `sifen-gateway-framework-free` to `.dependency-cruiser.cjs` (`from: (^|/)packages/sifen-gateway/src/`, `to: FW`); commit `feat(architecture): add sifen-gateway framework-isolation rule`.
- [x] 3.2 Create `apps/api/test/fixtures/boundaries/packages/sifen-gateway/src/framework-import.ts` importing `@nestjs/common`.
- [x] 3.3 RED: add case to `apps/api/test/architecture/boundaries.spec.ts` asserting the fixture triggers `sifen-gateway-framework-free`; run, confirm it fails; commit `test(architecture): add sifen-gateway boundary spec (red)`.
- [x] 3.4 GREEN: `--base-dir` does not exist in dependency-cruiser 18.4.0 CLI, confirmed via manual proof; applied documented fallback (package-local `.dependency-cruiser.cjs` that `extends` root, `from: ^src/`); commit `fix(architecture): wire sifen-gateway boundary check`.
- [x] 3.5 Verify: `pnpm --filter @sifen/api test -- boundaries.spec.ts`.

## Phase 4: Fake gateway (TDD, PR 2, stacked on PR 1)

- [ ] 4.1 RED: write `test/fake.spec.ts` covering: defaults per op, queue FIFO then default, each verified code (0300, 0301, 0361/0362, 0360, 0364, 0422, 0420, 0260), 15-event limit rejection with no successful record, timeout/transport rejection same-tick with no timers, missing default for `enviarEventos`/`consultarRUC`, call recording with copied args, `reset()`; run, capture failing line, commit `test(sifen-gateway): add fake scenario spec (red)`.
- [ ] 4.2 GREEN: implement `src/fake/scenarios.ts` builders (`loteRecibido`, `loteNoEncolado`, `loteInexistente`, `loteEnProcesamiento`, `loteConcluido`, `consultaExtemporanea`, `deAutorizado`, `cdcEncontrado`, `cdcInexistente`).
- [ ] 4.3 GREEN: implement `src/fake/fake-sifen-gateway.ts` (`enqueue`, `setDefault`, `calls`, `callsTo`, `reset`, `Scripted<T>`); wire barrel; commit `feat(sifen-gateway): add FakeSifenGateway`.
- [ ] 4.4 Verify: `pnpm --filter @sifen/sifen-gateway test && pnpm --filter @sifen/sifen-gateway lint`.

## Phase 5: CI wiring and close-out

- [ ] 5.1 Confirm `pnpm-workspace.yaml` picks up `packages/sifen-gateway` (no change expected; verify with `pnpm -r list`).
- [ ] 5.2 Confirm CI runs `build/typecheck/lint/depcruise/test` for the new package; verify: full `pnpm -r test`.
