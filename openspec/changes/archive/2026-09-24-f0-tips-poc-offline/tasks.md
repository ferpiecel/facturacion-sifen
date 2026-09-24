# Tasks: Offline PoC with the TIPS libraries (HU-E0-04, offline part)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~220, PR2 ~380 (excl. lockfile) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR1 → PR2 (PR2a/PR2b fallback if PR2 > 400) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Ports + contract test + ADR-0015 + README/0002 + plan §5.1 | PR 1 | `pnpm --filter @sifen/sifen-gateway test` | N/A — type-only, no runtime scenario | Revert `emission-ports.ts`/`.test.ts`, ADR-0015 row, plan §5.1 edit; additive, no consumers |
| 2 | `@sifen/sifen-tips` adapters + unit tests | PR 2a (if split) | `pnpm --filter @sifen/sifen-tips test` | N/A — mocked TIPS calls | Revert new package; no consumers yet |
| 3 | PoC e2e test + dev-cert/no-subprocess support | PR 2b (if split) | `pnpm --filter @sifen/sifen-tips test -- poc-offline` | Real offline flow: build→sign→QR→XSD→FakeSifenGateway, no network/JVM | Revert `test/support/*` and `poc-offline.e2e.test.ts`; isolated files |

## Phase 1: Ports (`@sifen/sifen-gateway`) — PR1

- [x] 1.1 Read `packages/sifen-gateway/node_modules/@types/node/` conventions and existing `packages/sifen-gateway/src/port.ts`/`types.ts` for style.
- [x] 1.2 RED: write `packages/sifen-gateway/src/emission-ports.spec.ts` (project convention uses `*.spec.ts`, not `*.test.ts` — vitest.config.ts only globs `*.spec.ts`) with `expectTypeOf` asserting `DeXmlBuilder`, `XmlSigner`, `QrGenerator`, `LoadedCertificate`, `QrConfig`, `Ambiente`, `FacturaPocInput` shapes per design Interfaces/Contracts. `vitest run` type-erases type-only imports (trivially green); true RED evidence is `pnpm --filter @sifen/sifen-gateway typecheck` → `TS2307: Cannot find module './emission-ports.ts'` at `emission-ports.spec.ts(10,8)`. Committed alone `test(sifen-gateway): add emission ports type contract (red)`.
- [x] 1.3 GREEN: create `packages/sifen-gateway/src/emission-ports.ts` with `Ambiente`, `LoadedCertificate`, `QrConfig`, `FacturaPocInput`, `DeXmlBuilder`, `XmlSigner`, `QrGenerator` (`addQr(signedXml, QrConfig): Promise<string>`, per design decision replacing plan §5.1 `buildUrl`). Tests and typecheck green. Committed `feat(sifen-gateway): add DeXmlBuilder, XmlSigner, QrGenerator ports`.
- [x] 1.4 Modify `packages/sifen-gateway/src/index.ts`: add type-only re-exports of the new ports/types.
- [x] 1.5 RED: write a depcruise/import-assertion test (`packages/sifen-gateway/src/emission-ports-boundaries.spec.ts`, a static regex import assertion — the shared `test/boundaries.spec.ts` cruises a synthetic fixture and isn't scoped to a single real file) asserting `emission-ports.ts` imports no TIPS library, `@nestjs/*`, `fastify`, `drizzle-orm`, `bullmq`. Passed immediately (ports already framework-free) — no failing state to capture, so no separate "(red)" commit per the task's conditional.
- [x] 1.6 GREEN: confirmed boundary test passes with no changes needed. Committed together with 1.4/1.5 as `feat(sifen-gateway): enforce emission ports import boundary` (no fix was required, so no separate labeled commit).
- [x] 1.7 Modify `.dependency-cruiser.cjs` (root): add rule that only `packages/sifen-tips` may import `facturacionelectronicapy-*`. Committed `feat(architecture): confine TIPS library imports to sifen-tips`.

## Phase 2: Documentation (ADR + plan) — PR1

- [x] 2.1 Create `docs/adr/0015-tips-libs-emision.md` (Spanish, MADR): context (ADR-0002 left xmlsign/qrgen pending), decision (xmlgen/qrgen/xmlsign Node-mode behind ports, pinned versions), open questions D7 (`dSisFact`) and D8 (two transforms) pending sifen-test/Prevalidador confirmation, own-signer fallback behind `XmlSigner`, consequence: dev certs generated at test time, never committed.
- [x] 2.2 Modify `docs/adr/README.md`: add row `0015` linking the new ADR, status `Aceptado`.
- [x] 2.3 Modify `docs/adr/0002-node-typescript-con-librerias-tips.md`: mark "Aceptado (enmendado por ADR-0015)" in the Estado line only (per ADR-0001, the decision/body text is never rewritten); mirrored the status note in `docs/adr/README.md`.
- [x] 2.4 Modify `docs/plan/plan-desarrollo-v1.1.md` §5.1: updated `QrGenerator` signature from `buildUrl(xmlFirmado, csc, ambiente): string` to `addQr(signedXml: string, config: QrConfig): Promise<string>`; added a note that it returns XML with `gCamFuFD` required by `rDE` before XSD validation.

## Phase 3: `@sifen/sifen-tips` package scaffold — PR2

- [x] 3.1 Created `packages/sifen-tips/package.json` mirroring `packages/sifen-xsd/package.json` conventions; deps: the 3 TIPS libs (pinned) + `@sifen/sifen-gateway`; devDeps: `@sifen/sifen-xsd`, `node-forge@1.4.0`, `@types/node-forge@1.3.14`. Committed `feat(sifen-tips): scaffold @sifen/sifen-tips package`.
- [x] 3.2 Created `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js` mirroring `packages/sifen-xsd`/`sifen-gateway`. Deviation from the literal task file names: test files use `*.spec.ts` (matching the repo-wide vitest include glob and PR1's precedent for gateway), not `*.test.ts`.
- [x] 3.3 Created `packages/sifen-tips/.dependency-cruiser.cjs`. Review fix: the root `tips-libs-confined-to-sifen-tips` rule's `pathNot: 'packages/sifen-tips/'` never matches a package-local run's relative `src/...` `from` paths, so it wrongly flagged this package's own adapters. The local config extends root and overrides that rule to `severity: 'ignore'` for this package (with the same `from`/`to`, required because the boundary test `require()`s this file directly, bypassing dependency-cruiser's own extends-merging). Proven by `test/boundaries.spec.ts`: passes for this package's own `src`, and still flags `test/fixtures/src/tips-import.js` under the root rule.
- [x] 3.4 Read `packages/sifen-tips/node_modules/facturacionelectronicapy-{xmlgen,xmlsign,qrgen}/dist/*.d.ts` and `.js` (after `pnpm install`) to confirm exact call signatures. Key finding not in design.md: under `moduleResolution: nodenext`, a default import types (and, in real Node, behaves) as the whole CJS module — `xmlgen.default.generateXMLDE`, not `xmlgen.generateXMLDE` — but Vitest's Vite-based runtime auto-unwraps the default already. Added `src/cjs-interop.ts` (`resolveCjsDefault`) so each adapter reads whichever shape is present.

## Phase 4: Adapters (TDD, RED then GREEN) — PR2

- [x] 4.1 RED: wrote `packages/sifen-tips/src/de-xml-builder.spec.ts` (`.spec.ts`, see 3.2 deviation) with `vi.mock('facturacionelectronicapy-xmlgen')` asserting `TipsDeXmlBuilder.buildParaSifen` forwards `FacturaPocInput.params`/`.data` to xmlgen and returns its XML. RED evidence: `Error: Cannot find module '/src/de-xml-builder.ts'`. Committed alone `test(sifen-tips): add de-xml-builder adapter test (red)`.
- [x] 4.2 GREEN: created `packages/sifen-tips/src/de-xml-builder.ts` implementing `DeXmlBuilder` via default-imported `xmlgen` + `resolveCjsDefault` (CJS interop, see 3.4), under 20 lines. Committed `feat(sifen-tips): add TipsDeXmlBuilder adapter`.
- [x] 4.3 RED: wrote `packages/sifen-tips/src/xml-signer.spec.ts` with `vi.mock('facturacionelectronicapy-xmlsign')` asserting `sign` always passes `signByNodeJS: true`, plus (review-required fixes) that the ephemeral cert directory is deleted after both a successful and a failed sign, and that `child_process.spawn`/`exec` are never called. RED evidence: `Error: Cannot find module '/src/xml-signer.ts'`. Committed alone `test(sifen-tips): add xml-signer adapter test (red)`.
- [x] 4.4 GREEN: created `packages/sifen-tips/src/xml-signer.ts` implementing `XmlSigner`, hard-coding `signByNodeJS: true`, writing `LoadedCertificate.p12` to an ephemeral 0600 temp file under `fs.mkdtemp(os.tmpdir())`, always removed in `finally` (xmlsign reads the p12 from a file path — confirmed in `XMLDsigNode.js`'s `fs.readFileSync(file)`). Committed `feat(sifen-tips): add TipsXmlSigner adapter (Node-mode only)`.
- [x] 4.5 RED: wrote `packages/sifen-tips/src/qr-generator.spec.ts` with `vi.mock('facturacionelectronicapy-qrgen')` asserting `addQr` forwards `idCsc`/`csc` and passes `QrConfig.ambiente` straight through as the qrgen `env` (`'test'`/`'prod'` already match; no separate URL mapping needed — qrgen builds the base URL internally). RED evidence: `Error: Cannot find module '/src/qr-generator.ts'`. Committed alone `test(sifen-tips): add qr-generator adapter test (red)`.
- [x] 4.6 GREEN: created `packages/sifen-tips/src/qr-generator.ts` implementing `QrGenerator.addQr(signedXml, config): Promise<string>`. Committed `feat(sifen-tips): add TipsQrGenerator adapter`.
- [x] 4.7 Created `packages/sifen-tips/src/index.ts` exporting the three adapters. Committed `feat(sifen-tips): export the three TIPS adapters from index`.

### Required fixes applied beyond the literal task text (apply-time)

- `packages/sifen-gateway/tsconfig.build.json`: added `declaration: true` (shared base sets `declaration: false`). `@sifen/sifen-tips` is the first real cross-package consumer of `@sifen/sifen-gateway`'s types; without this, `dist` had no `.d.ts` and typecheck failed with TS7016. Committed `fix(sifen-gateway): emit type declarations from the build`.
- `packages/sifen-tips/eslint.config.js`: added `test/fixtures/**` to `ignores` (mirrors `sifen-gateway`); the fixture file isn't part of the tsconfig project. Committed `fix(sifen-tips): exclude test/fixtures from typed eslint`.
- Prettier formatting fixes to 3 files after `//:format:check` caught line-length issues. Committed `style(sifen-tips): apply prettier formatting`.

## Phase 5: PoC offline e2e support — PR2 (PR2b if split)

- [x] 5.1 Created `packages/sifen-tips/test/support/dev-certificate.ts`: `node-forge`-based generator of a self-signed RSA-2048 cert, exported as in-memory PKCS#12; nothing written to disk. RED (`dev-certificate.spec.ts`, module-not-found) committed alone, then GREEN. Verified with a throwaway spike script that the resulting PKCS#12 signs correctly via the real `xmlsign` Node-mode path before writing the test.
- [x] 5.2 RED: wrote `packages/sifen-tips/test/support/no-subprocess-guard.ts` guard plus a smoke test asserting `child_process.spawn`/`spawnSync`/`exec`/`execSync`/`execFile`/`execFileSync`/`fork` throw when called, using `createRequire` + `syncBuiltinESMExports()`, installed before dynamic adapter `import()`, restored in `afterAll`. Failing state (`Cannot find module`) committed alone `test(sifen-tips): add no-subprocess guard tripwire test (red)`.
- [x] 5.3 GREEN: confirmed the guard traps calls and the tripwire test passes. Committed `feat(sifen-tips): install no-subprocess guard for offline tests`. Follow-up RED→GREEN pair added a `getGuardCallCount()` counter (needed for 6.4's "zero calls" assertion), not in the literal task text.

## Phase 6: PoC offline e2e test — PR2 (PR2b if split)

- [x] 6.1 Wrote `packages/sifen-tips/test/poc-offline.e2e.spec.ts` (deviation: `.spec.ts`, matching the repo-wide vitest glob and this package's own precedent, not `.test.ts`) asserting the full flow (build → sign → addQr → `@sifen/sifen-xsd` `validateXml('siRecepDE')` → `FakeSifenGateway.enviarLote`). Every underlying piece (adapters, dev certificate, guard) had already been proven end-to-end with a throwaway spike script (payload, sign, QR, XSD validate) before this test was written, so it passed on first run against the real, non-mocked libraries — no failing state to capture (same precedent as Phase 1 task 1.5 and Phase 3 task 3.3). Asserts no network access, valid XSD, `exc-c14n`/`rsa-sha256`/`sha256`, `KeyInfo` has only `X509Certificate`, `Reference URI` equals `#<DE Id>`.
- [x] 6.2 **Deviation from the literal task text**: the parent-injected apply scope for this session explicitly assigned `FakeSifenGateway.enviarLote`/`0300` instead of spec.md's `enviarDESincronico`/`0260` scenario. Implemented and asserted against `enviarLote`/`0300` per that explicit instruction; the fake's recorded call is asserted to include the exact signed+QR XML string sent. `spec.md`'s scenario text still describes `enviarDESincronico`/`0260` and needs a follow-up edit to match, or a documented rationale for the deviation.
- [x] 6.3 GREEN: wired the real FE payload fixture (`test/fixtures/poc-factura-input.ts`, proven working via the spike script), the dev certificate (5.1), CSC Id `0001`, the test QR base URL, and the three real adapters (Phase 4) — e2e test passes with the no-subprocess guard active. Committed `test(sifen-tips): add offline PoC e2e test (build-sign-qr-validate-send)` (a single `test:` commit covering 6.1+6.2+6.3, since there was no RED state to separate from GREEN).
- [x] 6.4 Confirmed zero `child_process` calls recorded by the guard (`getGuardCallCount() === 0`, spec: "Signer never spawns a JVM process"). Also verified independently: none of `facturacionelectronicapy-xmlsign`/`-xmlgen`/`-qrgen`'s installed `dist/*.js` reference `child_process` at all — Node-mode signing (`XMLDsigNode`) only uses `fs`, `xml-crypto`, `xml2js`, `xmlbuilder`, and `node-forge`.

## Phase 7: Verification / Cleanup — PR2

- [x] 7.1 Ran `rm -rf packages/*/dist apps/*/dist && pnpm turbo run format:check lint typecheck depcruise test build --force` from a clean state: 24/24 tasks green (includes `@sifen/sifen-gateway` and `@sifen/sifen-tips` test/typecheck).
- [x] 7.2 Confirmed via the same `depcruise` run (root + package-local rules, unchanged this session) that only `@sifen/sifen-tips` imports `facturacionelectronicapy-*`.
- [x] 7.3 Confirmed no `.p12`/certificate fixture file was added to the repository (spec: "Certificate is ephemeral") — `git status` shows only `.ts` files; `dev-certificate.ts` never writes to disk.
- [x] 7.4 Updated `proposal.md` Success Criteria checkboxes (all 4 now `[x]`, tracking only, no behavior change).

### Required fixes applied beyond the literal task text (apply-time, Phases 5-7)

- `packages/sifen-xsd/tsconfig.build.json`: added `declaration: true` (same root cause as the Phase 3/4 `sifen-gateway` fix — `dist` had no `.d.ts`, and `@sifen/sifen-tips`'s e2e test is the first real cross-package consumer of `@sifen/sifen-xsd`'s `validateXml` types). Committed `fix(sifen-xsd): emit type declarations from the build`.
- Prettier formatting fixes to 3 new files, committed `style(sifen-tips): apply prettier formatting`.
- Two consolidation refactors after the first GREEN pass, to reduce the hand-written line count: ran the e2e flow once in `beforeAll` instead of per-`it` (6x → 1x), and merged the guard's two single-purpose tripwire tests into one loop-driven test.

### Line-budget deviation (size:exception)

`git diff main...HEAD --shortstat -- . ':(exclude)pnpm-lock.yaml' ':(exclude)openspec'` → **7 files changed, 367 insertions(+), 1 deletion(-)**, above the session's stated ≤300 hand-written-line target. Breakdown: `poc-factura-input.ts` fixture 111 (a real xmlgen-required FE payload, proven end-to-end with a throwaway spike before being committed — every field is read by `generateXMLDE`/`generateQR`; not padding), `poc-offline.e2e.spec.ts` 87, `dev-certificate.ts`+`.spec.ts` 62, `no-subprocess-guard.ts`+`.spec.ts` 62, `sifen-xsd` config fix 3, `dev-certificate.spec.ts` 25. Two consolidation passes already cut ~90 lines (124→87 on the e2e spec, 53→43 then docstring trim on the guard) without losing any of the prompt's mandated assertions (XSD validity, signature algorithm triad, KeyInfo shape, Reference URI, QR URL/IdCSC, FakeSifenGateway call+code, zero guarded calls, D7/D8 facts) or the guard's coverage of all 7 `child_process` entry points. Further cuts would require either dropping an explicitly requested assertion or hand-compressing the FE payload in a way that risks silently breaking the proven-working `xmlgen`/`xmlsign`/`qrgen` chain. Recommend `size:exception` for this PR.
