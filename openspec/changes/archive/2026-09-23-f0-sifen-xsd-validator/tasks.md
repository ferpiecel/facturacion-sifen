# Tasks: SIFEN XSD validator package (HU-E0-06)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~200, PR2 ~180 (hand-written; vendor XSDs + `pnpm-lock.yaml` excluded) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR1 (skeleton + vendor + checksum scripts + CI) → PR2 (draft, `Depende de #PR1`: validator + fixtures + tests) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Package skeleton, vendored XSDs, checksum scripts, CI/turbo wiring | PR 1 | `pnpm turbo run verify-vendor --filter=@sifen/sifen-xsd` | `pnpm turbo run verify-vendor` (offline, real script) | Revert squash commit; removes `packages/sifen-xsd/{scripts,vendor,*.json,*.config*}`, `turbo.json`/`ci.yml`/`.prettierignore` edits |
| 2 | `validateXml` adapter, schema map, fixtures, tests | PR 2 | `pnpm turbo run test --filter=@sifen/sifen-xsd` | `pnpm --filter @sifen/sifen-xsd test` against vendored XSDs (real, offline) | Revert squash commit; removes `src/{schemas,validate-xml}.ts`, `test/**`; PR1 artifacts untouched |

## Phase 1: Package Skeleton (PR1)

- [x] 1.1 Create `packages/sifen-xsd/package.json` (`type: module`, exports `./dist/index.js`, scripts `build/typecheck/lint/depcruise/test/verify-vendor/refresh-xsd`, `libxml2-wasm` pinned exact `0.7.2`)
- [x] 1.2 Create `packages/sifen-xsd/tsconfig.json` and `tsconfig.build.json` extending `@sifen/config` (`module: nodenext`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`)
- [x] 1.3 Create `packages/sifen-xsd/eslint.config.js` extending shared config; ignore `dist/**`, `vendor/**`
- [x] 1.4 Create `packages/sifen-xsd/vitest.config.ts` mirroring `apps/api`
- [x] 1.5 Create `packages/sifen-xsd/src/index.ts` as an empty placeholder module (real exports land in 6.9)

## Phase 2: Checksum Scripts — RED/GREEN (PR1)

- [x] 2.1 RED: `packages/sifen-xsd/test/verify-checksums.spec.ts` — tampered byte, missing file, extra file each produce non-zero exit and name the mismatched file (design test 5)
- [x] 2.2 GREEN: create `packages/sifen-xsd/scripts/checksums.ts` (shared sha256/manifest helpers)
- [x] 2.3 GREEN: create `packages/sifen-xsd/scripts/verify-checksums.ts` (CI integrity check) to pass 2.1
- [x] 2.4 Wire `verify-vendor` script in `package.json` to run `verify-checksums.ts`

## Phase 3: Vendor Refresh Workflow (PR1)

- [x] 3.1 Create `packages/sifen-xsd/scripts/refresh-xsd.ts` — download with redirect-follow, transitive `xsd:include`/`xsd:import` closure (regex tolerant of whitespace around `=`), abort on drift unless `--update`
- [x] 3.2 Run `refresh-xsd.ts --update` to populate `packages/sifen-xsd/vendor/*.xsd` with the verified 8-file `siRecepDE_v150` closure and generate `vendor/checksums.json`
- [x] 3.3 Create `packages/sifen-xsd/vendor/README.md` documenting source URLs and fetch date

## Phase 4: CI / Turbo Wiring (PR1)

- [x] 4.1 Modify `turbo.json`: add `verify-vendor` task, no `dependsOn`, `inputs: ["vendor/**", "scripts/**"]`
- [x] 4.2 Modify `.github/workflows/ci.yml`: add `verify-vendor` to the quality-gate matrix
- [x] 4.3 Modify `.prettierignore`: add `packages/sifen-xsd/vendor/`
- [x] 4.4 Verify: `pnpm turbo run verify-vendor lint typecheck test --filter=@sifen/sifen-xsd`

## Phase 5: Schema Map & Fixture Helper (PR2, draft, depends on PR1)

- [x] 5.1 Create `packages/sifen-xsd/src/schemas.ts` — `SifenSchema = 'siRecepDE'` → root file map, `vendorDir` from `import.meta.url`
- [x] 5.2 Create `packages/sifen-xsd/test/fixtures/patch-example.ts` — patches `docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml` (read-only): RUCs `80000001`/`80000002`, `<dBasExe>0</dBasExe>` in each `gCamIVA`, dummy base64 certificate

## Phase 6: Validator Core — RED/GREEN per Scenario (PR2)

- [x] 6.1 RED: `test/validate-xml.spec.ts` — untouched official example is invalid (asserts the 3 documented failures: RUC pattern, missing `dBasExe`, non-base64 cert)
- [x] 6.2 RED: patched valid fixture → `validateXml(..., 'siRecepDE')` returns `valid: true`, `errors: []` (spec: Official signed example validates)
- [x] 6.3 GREEN: create `packages/sifen-xsd/src/validate-xml.ts` — register `XmlBufferInputProvider` per vendored file (absolute URL + bare name), `XsdValidator.fromDoc` cached per schema, `dispose()` every parsed doc
- [x] 6.4 RED: remove `dVerFor` from the patched fixture → `valid: false`, error names the missing element (spec: Missing required element)
- [x] 6.5 RED: set `iTipEmi` to `9` on the patched fixture → `valid: false`, actionable enum error (spec: Wrong enum value)
- [x] 6.6 RED: malformed XML string → `valid: false`, no throw (design test 4)
- [x] 6.7 GREEN: extend `validate-xml.ts` error normalization (`XsdError { message, line, column, path }`) to pass 6.4–6.6
- [x] 6.8 RED: assert `validate-xml.ts` makes no outbound network call during validation (spec: Validation runs without network access)
- [x] 6.9 Update `src/index.ts`: export `validateXml`, `SifenSchema`, `XsdError`, `ValidationResult`

## Phase 7: Cleanup (PR2)

- [x] 7.1 Final pass on `package.json` exports/deps; confirm `libxml2-wasm` stays pinned exact `0.7.2`
- [x] 7.2 Run `pnpm turbo run lint typecheck test verify-vendor --filter=@sifen/sifen-xsd`; note `pnpm-lock.yaml` diff for `libxml2-wasm` (gentle-ai budget: lockfile changes grow the diff but are excluded from the 400-line count)
