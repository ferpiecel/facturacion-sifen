# Proposal: SIFEN XSD validator package (HU-E0-06)

## Intent

Every DE we emit must be schema-valid before signing and transmission. Today there is no offline way to validate XML against the official DNIT XSDs, and CI cannot depend on `ekuatia.set.gov.py` availability. This change delivers a deterministic, offline validator that later changes (XML generation, signing, SOAP mock) build on.

## Scope

### In Scope
- New package `packages/sifen-xsd` exposing `validateXml(xml: string, schema: SifenSchema) => { valid: boolean; errors: XsdError[] }` (`SifenSchema` = `'siRecepDE' | ...` covering the vendored roots), wrapping `libxml2-wasm` 0.7.2.
- Vendored official v150 XSD graph (plus referenced v141 files and `xmldsig-core-schema`) under `packages/sifen-xsd/vendor/`, with `checksums.json` (sha256).
- Refresh script: downloads from DNIT, follows redirects, verifies sha256, fails on drift unless explicitly updating.
- Tests (strict TDD, Vitest): `docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml` as valid fixture; at least 2 invalid fixtures (missing required element, wrong enum value).
- CI: package runs in existing lint/typecheck/test gates; new offline check that vendored files match `checksums.json`.

### Out of Scope
- SOAP mock (`f0-sifen-soap-mock`, HU-E0-05).
- XML generation, signing, event XSD usage beyond making files available.
- Using `estructura-de-NO-v150.xsd` (not v150).

## Capabilities

### New Capabilities
- `sifen-xsd-validation`: offline XSD validation API, vendored schema integrity, refresh workflow.

### Modified Capabilities
- `ci-pipeline`: quality gates add a vendored-XSD checksum verification step that fails CI on mismatch.

## Approach

Thin adapter over `libxml2-wasm` `XsdValidator`, resolving `xsd:include`/`xsd:import` from the vendored directory only (no network). Errors normalized to `{ message, line?, column? }` so the pre-1.0 dependency stays swappable (`xmllint-wasm` fallback). Checksum verification is a pure Node script reused by CI and the refresh script.

## PR Slicing (auto-chain, all to `main`)

Single PR expected (~150–250 hand-written lines; vendored XSDs and lockfile excluded). If the tasks forecast exceeds 400, split: PR1 vendor + checksums + refresh/verify scripts + CI step; PR2 (draft, `Depende de`) validator + fixtures + tests.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/sifen-xsd/` | New | Package, vendor dir, scripts, tests |
| `.github/workflows/ci.yml` | Modified | Checksum verification step |
| `pnpm-lock.yaml` | Modified | `libxml2-wasm` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| DNIT redirects / site down | Med | Follow redirects; CI fully offline |
| No explicit redistribution license | Low | Public normative schemas; source URL recorded in `checksums.json` |
| `libxml2-wasm` pre-1.0 API churn | Med | Pinned version, wrapped behind `validateXml()` |
| Include/import resolution in WASM FS | Med | Early TDD test on the full `siRecepDE` graph |

## Rollback Plan

Revert the squash commit(s): removes `packages/sifen-xsd` and the CI step; no consumers exist yet, no data migration.

## Dependencies

- `libxml2-wasm` 0.7.2 (MIT). ADRs: 0002 (Node/TypeScript stack), 0004 (monorepo; shared library under `packages/`), 0012 (technical notes prevail over Manual Técnico).

## Success Criteria

- [ ] Official signed example validates against `siRecepDE`; both invalid fixtures fail with actionable errors.
- [ ] Tests pass offline; CI green including checksum check.
- [ ] Tampering one vendored XSD fails CI.
