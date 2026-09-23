# Design: SIFEN XSD validator package (HU-E0-06)

## Technical Approach

New framework-free ESM package `@sifen/sifen-xsd` (`packages/sifen-xsd`). `validateXml()` is a thin adapter over `libxml2-wasm` `XsdValidator`; schemas load only from `vendor/` through a restricted file input provider (no network). Vendored files are integrity-checked by a pure Node script exposed as a new turbo task `verify-vendor`, added to the CI matrix, so the empty-graph guard stays meaningful.

## Architecture Decisions

| Topic | Options | Tradeoff | Decision |
|---|---|---|---|
| Validator | `libxml2-wasm` 0.7.2 / `xmllint-wasm` / native `libxmljs2` | native needs `allowBuilds`; xmllint spawns whole CLI | `libxml2-wasm` pinned exact `0.7.2`, wrapped behind `validateXml()` |
| XSD file list | hand-written list / derived closure | hand list drifts silently | Refresh script computes the transitive closure of `xsd:include`/`xsd:import` from roots; `checksums.json` is the authoritative list |
| Include resolution | inline all XSDs into one doc / input provider scoped to `vendor/` | inlining edits normative files | Register a provider that resolves only paths under `vendor/`; any other URI (http, `..`) fails |
| Vendor location at runtime | copy into `dist/` / `new URL('../vendor/', import.meta.url)` | copying adds build step | `import.meta.url`: `src/` (tests) and `dist/` (build) are both one level below `vendor/` |
| Checksum gate | step inside `test` / separate turbo task | hiding it in tests blurs failure cause | Turbo task `verify-vendor` + CI matrix entry; no `dependsOn`, `inputs: ["vendor/**", "scripts/**"]` |
| Invalid fixtures | committed XML copies / in-test mutation of the official example | copies cost ~2x example size in reviewed lines | Mutate `docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml` in-test (remove one required element; replace one enum value) |
| Scripts runtime | `tsx` dep / `node --experimental-strip-types` | extra dep vs flag | Node strip-types (engines `>=22.12`); tsconfig `erasableSyntaxOnly`, `rewriteRelativeImportExtensions` |
| Error shape | raw lib errors / normalized | raw leaks pre-1.0 API | Normalized `XsdError` (below) |

## Data Flow

    xml string ──> XmlDocument.fromString ──> XsdValidator(root schema)
                                                 │ include/import
                                   vendor-only input provider ──> vendor/*.xsd
    validate() ── throws/returns lib errors ──> normalize ──> { valid, errors[] }

    refresh-xsd.ts: roots ─fetch(redirect: follow)─> parse schemaLocation ─> closure
                    ─> write vendor/ + checksums.json (only with --update; else fail on drift)
    verify-checksums.ts: sha256(vendor/*) == checksums.json, no missing/extra files

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/sifen-xsd/package.json` | Create | `type: module`, exports `./dist/index.js`, scripts build/typecheck/lint/depcruise/test/verify-vendor/refresh-xsd |
| `packages/sifen-xsd/{tsconfig,tsconfig.build}.json`, `eslint.config.js`, `vitest.config.ts` | Create | Extend `@sifen/config` (base + `module: nodenext`), mirror `apps/api` |
| `packages/sifen-xsd/src/index.ts` | Create | Public re-exports |
| `packages/sifen-xsd/src/schemas.ts` | Create | `SifenSchema` → root file map, `vendorDir` URL |
| `packages/sifen-xsd/src/validate-xml.ts` | Create | Adapter, provider registration (once), error normalization |
| `packages/sifen-xsd/scripts/checksums.ts` | Create | Shared sha256/manifest helpers |
| `packages/sifen-xsd/scripts/verify-checksums.ts` | Create | CI integrity check |
| `packages/sifen-xsd/scripts/refresh-xsd.ts` | Create | Download, closure, drift check, `--update` |
| `packages/sifen-xsd/vendor/*.xsd`, `vendor/checksums.json`, `vendor/README.md` | Create | Unmodified DNIT files; source URL + fetch date |
| `packages/sifen-xsd/test/validate-xml.spec.ts`, `test/verify-checksums.spec.ts` | Create | Tests |
| `turbo.json` | Modify | Add `verify-vendor` task |
| `.github/workflows/ci.yml` | Modify | Add `verify-vendor` to matrix |
| `.prettierignore` | Modify | Add `packages/sifen-xsd/vendor/` |

ESLint ignores `dist/**`, `vendor/**`.

## Interfaces / Contracts

```ts
export type SifenSchema = 'siRecepDE';
export interface XsdError { message: string; line: number | null; column: number | null; path: string | null }
export interface ValidationResult { valid: boolean; errors: readonly XsdError[] }
export function validateXml(xml: string, schema: SifenSchema): ValidationResult;
```

The function never throws for invalid or malformed XML: parse errors become `errors`. `path` is the failing element (from lib details or the `Element '...'` message prefix), else `null`. Compiled validators are cached per schema.

## Testing Strategy (strict TDD order)

1. RED: official example is valid against `siRecepDE` (proves include/import resolution across the full graph; spike point for the API assumptions).
2. RED: missing required element → `valid: false`, error with line and element.
3. RED: wrong enum value → actionable message.
4. RED: malformed XML → error, no throw.
5. RED: verify-checksums on a temp copy with one tampered byte / missing file / extra file → non-zero exit.

All tests offline. `refresh-xsd` is not run in CI.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The only I/O boundary (schema resolution) is restricted to `vendor/` by design.

## Slicing (hand-written lines, vendor and lockfile excluded)

| PR | Content | Estimate |
|---|---|---|
| PR1 | Package skeleton, configs, vendor, checksum scripts + test, turbo/CI/prettier | ~200 |
| PR2 (draft, `Depende de`) | `schemas.ts`, `validate-xml.ts`, validator tests | ~180 |

Single-PR total (~380) sits at the budget edge, so two chained PRs.

## Migration / Rollout

No migration required.

## Open Questions

- [ ] Not verified in this phase (no network access in the design executor): the `libxml2-wasm@0.7.2` API for input providers and error details, and the exact XSD closure list. PR1 must run `refresh-xsd --update` and record the real file count. PR2 test 1 is the spike for the API. If include resolution fails, fall back to `xmllint-wasm` behind the same contract.
- [ ] Add event roots (`siRecepEvento`) now or in the change that signs events. Default: later.

## Verified Facts (orchestrator spike, 2026-09-23)

The design phase could not run commands. The orchestrator ran these checks in a scratch directory. They replace the corresponding "unverified" assumptions above.

### XSD closure for `siRecepDE_v150.xsd`: 8 files, 287,316 bytes

| File | Bytes | sha256 (prefix) | References |
|---|---|---|---|
| `siRecepDE_v150.xsd` | 395 | c4f566981645 | `https://ekuatia.set.gov.py/sifen/xsd/DE_v150.xsd` |
| `DE_v150.xsd` | 66,190 | 83435e6aa50c | `xmldsig-core-schema.xsd` (relative), then absolute URLs to `Paises_v100`, `Departamentos_v141`, `Monedas_v150`, `Unidades_Medida_v141`, `DE_Types_v150` |
| `DE_Types_v150.xsd` | 66,452 | 99c5c2ca69ea | none |
| `Paises_v100.xsd` | 53,266 | b75edd6b8ee0 | none |
| `Departamentos_v141.xsd` | 6,198 | 1de13902a775 | none |
| `Monedas_v150.xsd` | 57,236 | 16520dd42b5a | none |
| `Unidades_Medida_v141.xsd` | 27,240 | 8a25e5e5decc | none |
| `xmldsig-core-schema.xsd` | 10,339 | f2c353a12387 | none |

- Includes mix **absolute URLs** and **relative names**. Vendored files are stored **unmodified**. Resolution happens at runtime through the input provider, not by rewriting `schemaLocation`, so the checksums always match the official bytes.
- The regex that discovers references must allow whitespace around `=`, as in `schemaLocation= "..."`.

### libxml2-wasm 0.7.2 API: works with include resolution

```ts
import { XmlDocument, XsdValidator, XmlBufferInputProvider, xmlRegisterInputProvider, XmlValidateError } from 'libxml2-wasm';
// Register every vendored file under BOTH its official absolute URL and its bare filename.
xmlRegisterInputProvider(new XmlBufferInputProvider({ [`https://ekuatia.set.gov.py/sifen/xsd/${name}`]: buf, [name]: buf }));
const xsd = XmlDocument.fromBuffer(rootBuf, { url: 'https://ekuatia.set.gov.py/sifen/xsd/siRecepDE_v150.xsd' });
const validator = XsdValidator.fromDoc(xsd);   // compile once, reuse
validator.validate(XmlDocument.fromString(xml)); // throws XmlValidateError with .details[{ line, message }]
```

- Documents and validators are `XmlDisposable`. Call `dispose()` on every parsed document, or memory leaks inside the WASM heap.
- `xmlRegisterInputProvider` is process-global. Register it once, in module scope.

### The official signed example is NOT valid against the current XSD

Validating `docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml` gives:

1. `dRucEm` `00000001` and `dRucRec` `00000002` fail the pattern `[1-9][0-9]*[0-9A-D]?`, because they are placeholder RUCs.
2. `gCamIVA` is missing the required `dBasExe` (lines 106 and 131). The example predates **NT 013** (E737 `dBasExe`), which confirms that the published XSD already includes the technical notes.
3. `X509Certificate` holds placeholder text, not `xs:base64Binary`.

**Consequence for fixtures**: the valid fixture is the official example with exactly these patches: RUCs `80000001` and `80000002`, `<dBasExe>0</dBasExe>` added in each `gCamIVA` in schema order, and a base64 dummy certificate. The patch lives in a test helper, and a test also asserts that the untouched official example is invalid, for exactly these reasons. Invalid fixtures are derived from the valid one: remove `dVerFor` (expected-element error) and set `iTipEmi` to `9` (pattern error).
