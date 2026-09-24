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

- [ ] 1.1 Read `packages/sifen-gateway/node_modules/@types/node/` conventions and existing `packages/sifen-gateway/src/port.ts`/`types.ts` for style.
- [ ] 1.2 RED: write `packages/sifen-gateway/src/emission-ports.test.ts` with `expectTypeOf` asserting `DeXmlBuilder`, `XmlSigner`, `QrGenerator`, `LoadedCertificate`, `QrConfig`, `Ambiente`, `FacturaPocInput` shapes per design Interfaces/Contracts. Run `pnpm --filter @sifen/sifen-gateway test`, capture the failing line (module not found), commit alone `test(sifen-gateway): add emission ports type contract (red)`.
- [ ] 1.3 GREEN: create `packages/sifen-gateway/src/emission-ports.ts` with `Ambiente`, `LoadedCertificate`, `QrConfig`, `FacturaPocInput`, `DeXmlBuilder`, `XmlSigner`, `QrGenerator` (`addQr(signedXml, QrConfig): Promise<string>`, per design decision replacing plan §5.1 `buildUrl`). Run tests green. Commit `feat(sifen-gateway): add DeXmlBuilder, XmlSigner, QrGenerator ports`.
- [ ] 1.4 Modify `packages/sifen-gateway/src/index.ts`: add type-only re-exports of the new ports/types.
- [ ] 1.5 RED: write a depcruise/import-assertion test (extend `packages/sifen-gateway/test/boundaries.spec.ts` or new spec) asserting `emission-ports.ts` imports no TIPS library, `@nestjs/*`, `fastify`, `drizzle-orm`, `bullmq`. Run, capture failing state if any, commit `test(sifen-gateway): assert emission ports import boundaries (red)` only if it fails first.
- [ ] 1.6 GREEN: confirm boundary test passes with no changes needed (ports are already framework-free) or adjust imports. Commit `feat(sifen-gateway): enforce emission ports import boundary` if any fix was required.
- [ ] 1.7 Modify `.dependency-cruiser.cjs` (root): add rule that only `packages/sifen-tips` may import `facturacionelectronicapy-*`.

## Phase 2: Documentation (ADR + plan) — PR1

- [ ] 2.1 Create `docs/adr/0015-tips-libs-emision.md` (Spanish, MADR): context (ADR-0002 left xmlsign/qrgen pending), decision (xmlgen/qrgen/xmlsign Node-mode behind ports, pinned versions), open questions D7 (`dSisFact`) and D8 (two transforms) pending sifen-test/Prevalidador confirmation, own-signer fallback behind `XmlSigner`, consequence: dev certs generated at test time, never committed.
- [ ] 2.2 Modify `docs/adr/README.md`: add row `0015` linking the new ADR, status `Aceptado`.
- [ ] 2.3 Modify `docs/adr/0002-node-typescript-con-librerias-tips.md`: mark "Enmendado por 0015" per ADR-0012 precedent.
- [ ] 2.4 Modify `docs/plan/plan-desarrollo-v1.1.md` §5.1: update `QrGenerator` signature from `buildUrl(xmlFirmado, csc, ambiente): string` to `addQr(signedXml: string, config: QrConfig): Promise<string>`; note it returns XML with `gCamFuFD` required by `rDE` before XSD validation.

## Phase 3: `@sifen/sifen-tips` package scaffold — PR2

- [ ] 3.1 Create `packages/sifen-tips/package.json` mirroring `packages/sifen-xsd/package.json` conventions; deps: `facturacionelectronicapy-xmlgen@1.0.283`, `facturacionelectronicapy-xmlsign@1.0.28`, `facturacionelectronicapy-qrgen@1.0.9`, `@sifen/sifen-gateway`; devDeps: `@sifen/sifen-xsd`, `node-forge@1.4.0`, `@types/node-forge@1.3.14`.
- [ ] 3.2 Create `packages/sifen-tips/tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js` mirroring `packages/sifen-xsd`.
- [ ] 3.3 Create `packages/sifen-tips/.dependency-cruiser.cjs` (or confirm root rule from 1.7 covers it) permitting `facturacionelectronicapy-*` imports only within this package.
- [ ] 3.4 Read `packages/sifen-tips/node_modules/facturacionelectronicapy-xmlgen`, `-xmlsign`, `-qrgen` typings (after `pnpm install`) to confirm exact call signatures before writing adapters.

## Phase 4: Adapters (TDD, RED then GREEN) — PR2

- [ ] 4.1 RED: write `packages/sifen-tips/src/de-xml-builder.test.ts` with `vi.mock('facturacionelectronicapy-xmlgen')` asserting `TipsDeXmlBuilder.buildParaSifen` forwards `FacturaPocInput.params`/`.data` to xmlgen and returns its XML. Run, capture failing line (module not found), commit alone `test(sifen-tips): add de-xml-builder adapter test (red)`.
- [ ] 4.2 GREEN: create `packages/sifen-tips/src/de-xml-builder.ts` implementing `DeXmlBuilder` via default-imported `xmlgen` (CJS interop per design), under ~40 lines. Commit `feat(sifen-tips): add TipsDeXmlBuilder adapter`.
- [ ] 4.3 RED: write `packages/sifen-tips/src/xml-signer.test.ts` with `vi.mock('facturacionelectronicapy-xmlsign')` asserting `sign` always passes `signByNodeJS: true`. Run, capture failing line, commit alone `test(sifen-tips): add xml-signer adapter test (red)`.
- [ ] 4.4 GREEN: create `packages/sifen-tips/src/xml-signer.ts` implementing `XmlSigner`, hard-coding `signByNodeJS: true`, converting `LoadedCertificate.p12` to the Buffer/temp-path shape xmlsign expects (via `os.tmpdir()` + `mkdtemp`, removed in `finally` if a path is required). Commit `feat(sifen-tips): add TipsXmlSigner adapter (Node-mode only)`.
- [ ] 4.5 RED: write `packages/sifen-tips/src/qr-generator.test.ts` with `vi.mock('facturacionelectronicapy-qrgen')` asserting `addQr` maps `QrConfig.ambiente` to test/prod base URL and forwards `idCsc`/`csc`. Run, capture failing line, commit alone `test(sifen-tips): add qr-generator adapter test (red)`.
- [ ] 4.6 GREEN: create `packages/sifen-tips/src/qr-generator.ts` implementing `QrGenerator.addQr(signedXml, config): Promise<string>`. Commit `feat(sifen-tips): add TipsQrGenerator adapter`.
- [ ] 4.7 Create `packages/sifen-tips/src/index.ts` exporting the three adapters.

## Phase 5: PoC offline e2e support — PR2 (PR2b if split)

- [ ] 5.1 Create `packages/sifen-tips/test/support/dev-certificate.ts`: `node-forge`-based generator of a self-signed RSA-2048 cert, exported as in-memory PKCS#12; nothing written to disk.
- [ ] 5.2 RED: write `packages/sifen-tips/test/support/no-subprocess-guard.ts` guard plus a smoke test asserting `child_process.spawn`/`spawnSync`/`exec`/`execSync`/`execFile`/`execFileSync`/`fork` throw when called, using `createRequire` + `syncBuiltinESMExports()`, installed before dynamic adapter `import()`, restored in `afterAll`. Run, capture failing state, commit alone `test(sifen-tips): add no-subprocess guard (red)`.
- [ ] 5.3 GREEN: confirm the guard traps calls and the tripwire test passes. Commit `feat(sifen-tips): install no-subprocess guard for offline tests`.

## Phase 6: PoC offline e2e test — PR2 (PR2b if split)

- [ ] 6.1 RED: write `packages/sifen-tips/test/poc-offline.e2e.test.ts` asserting the full flow (build → sign → addQr → `@sifen/sifen-xsd` `validateXml('siRecepDE')` → `FakeSifenGateway.enviarDESincronico`) per spec scenario "Full offline flow succeeds": no network, valid XSD, signature uses `exc-c14n`/`rsa-sha256`/`sha256`, `KeyInfo` has only `X509Certificate`, `Reference URI` equals `#<DE Id>`. Run against real (non-mocked) adapters, capture the failing line, commit alone `test(sifen-tips): add offline PoC e2e test (red)`.
- [ ] 6.2 Extend the same test file (or a follow-up assertion) per spec scenario "FakeSifenGateway receives the signed XML": assert the fake's recorded call includes the exact signed+QR XML string sent.
- [ ] 6.3 GREEN: wire the test FE payload, dev certificate (5.1), CSC Id `0001`, test base URL, and the three adapters (Phase 4) until the e2e test passes with the no-subprocess guard active. Commit `feat(sifen-tips): pass offline PoC e2e (build-sign-qr-validate-send)`.
- [ ] 6.4 Confirm zero `child_process` calls recorded by the guard (spec: "Signer never spawns a JVM process").

## Phase 7: Verification / Cleanup — PR2

- [ ] 7.1 Run `pnpm --filter @sifen/sifen-gateway test`, `pnpm --filter @sifen/sifen-tips test`, `pnpm --filter @sifen/sifen-gateway typecheck`, `pnpm --filter @sifen/sifen-tips typecheck`; confirm all green.
- [ ] 7.2 Run `pnpm depcruise` (or package-level equivalent) confirming only `@sifen/sifen-tips` imports `facturacionelectronicapy-*`.
- [ ] 7.3 Confirm no `.p12`/certificate fixture file was added to the repository (spec: "Certificate is ephemeral").
- [ ] 7.4 Update proposal.md Success Criteria checkboxes once all pass (tracking only, no behavior change).
