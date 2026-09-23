# Exploration: SIFEN XSD validation (HU-E0-06)

Full exploration (shared with the later SOAP mock change): engram `sdd/f0-sifen-mock-xsd/explore`.

## Decisions carried into the proposal (tech lead)

- **Split**: HU-E0-06 (this change) and HU-E0-05 SOAP mock (later change `f0-sifen-soap-mock`) have no code coupling.
- **Source**: official schemas at `https://ekuatia.set.gov.py/sifen/xsd/` (50 files, v141/v150, linked via `xsd:include`/`xsd:import`). No published license; they are public normative government schemas.
- **Vendoring**: store the required v150 graph (plus the v141 lookups it references and `xmldsig-core-schema`) under `packages/sifen-xsd/vendor/` with a `checksums.json` (sha256) and a refresh script. CI must not depend on the DNIT site being up. Vendored XSDs are excluded from the 400-line review budget, like the lockfile.
- **Validator**: `libxml2-wasm` 0.7.2 (MIT, pure WASM, no native build, `XsdValidator` with include/import support). Fallback: `xmllint-wasm`.
- **Placement**: `packages/sifen-xsd` (shared library per ADR-0004). No dependency-cruiser change needed.
- **First fixture**: `docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml` (official signed DE example, root validated by `siRecepDE_v150.xsd`). `docs/referencia/ejemplos/estructura-de-NO-v150.xsd` is NOT v150 and must not be used.

## Size

About 150–250 hand-written lines, excluding the vendored XSDs.

## Risks

- The DNIT site redirects HTTP to another location. The refresh script must follow redirects and verify checksums.
- There is no explicit redistribution license for the XSDs.
- `libxml2-wasm` is pre-1.0, so its API may change. It gets wrapped behind a small `validateXml()` function.
