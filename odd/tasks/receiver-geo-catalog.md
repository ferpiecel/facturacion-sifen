# Receiver address contract and geographic catalog

- Feature: `receiver-geo-catalog` · Refs: HU-E5-08 (F2; integration gap found while documenting `POST /v1/documents`)
- Engram mirror: `odd/receiver-geo-catalog/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`, thresholds 85%)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; each PR about 400 changed lines or less (advisory), generated data declared per PR.
- Status: slice A done in two chained PRs (A1: T1 + domain half of T2; A2: rest of T2 + T3); slices B-E pending.

## Objective

Make the receiver address of `POST /v1/documents` follow the SIFEN rules, and give integrators a way to obtain
valid department, district and city codes without keeping their own table.

## Problem (gap analysis)

- The API requires address, house number, department, district and city for every named receiver
  (`create-document.request.ts`). SIFEN makes the address optional (0-1) except for B2F and the Nota de
  Remision, so the API is stricter than the norm and forces integrators to invent data.
- The XML always carries `cDepRec` and `cCiuRec`. The norm says they must not be informed for B2F
  (`D202 = 4`). Not yet confirmed how the TIPS library treats B2F; treat as a probable defect until tested.
- District and city codes are checked only for format, and their descriptions are copied to the XML. SIFEN
  rejects a description that does not match its code, so the integrator finds out at transmission, not at
  acceptance. Only the department table is vendored (`Departamentos_v141.xsd`).
- The geographic table (Tabla 2.1) is an external file, `CODIGO DE REFERENCIA GEOGRAFICA.xlsx`, published by
  the DNIT. It is not in the repository, and `department.ts` still says the table is "not present anywhere".

## Normative basis

- Manual Tecnico v150, group D3: D213 `dDirRec` 0-1, mandatory when C002 = 7 or D202 = 4; D218 house number
  mandatory if D213 is informed; D219 `cDepRec` and D223 `cCiuRec` mandatory if D213 is informed and
  D202 != 4, not to be informed when D202 = 4; D221 `cDisRec` 0-1 with D222 mandatory if D221 exists.
- NT 003 validations 1324 (department) and 1327 (city); NT 010 validation 1325 and NT 017 validation 1329
  (description must match the code); NT 014 validations 4470 (house number) and 4478 (B2F requires address).
- Precedence follows ADR-0012. The notes above prevail over the Manual; none of them reverses the rules.

## Scope

In: contract alignment (slice A), catalog vendoring and validation (slices B and C), read endpoints
(slice D), documentation (slice E).
Out: Nota de Remision address rules, emission of other document types, transport/delivery locations
(E3 and E10 groups), issuer address (already configured per establishment).

## Constraints

- Loosening a validation is backward compatible; the B2F tightening is not, and must be called out in the PR.
- The catalog is public data: no tenant isolation concern, but endpoints still require a valid API key.
- Validation stays pure and framework free in `domain/`; the catalog is data behind a domain function.
- A vendored dataset carries a checksum, like `packages/sifen-xsd/vendor/checksums.json`.
- No catalog value is invented: if the source file is unavailable, slices B to D stay blocked.

## Technical decisions (to record in ADR-0017)

| Decision | Rationale |
|---|---|
| Keep the current flat field names; make address fields optional with conditional rules | No breaking rename for integrators already coding against the OpenAPI |
| Address block is all or nothing: address + house number, then department and city unless B2F | Mirrors D213/D218/D219/D223 |
| B2F requires address and rejects department and city | NT 014 (4478) and Manual D219/D223 |
| Catalog is vendored data in the repo, not fetched at runtime | Deterministic validation, no external dependency on the portal |
| Department description stays resolved by the platform; district and city descriptions are validated, not trusted | SIFEN rejects mismatches (1325, 1329) |
| Read endpoints are `GET /v1/geo/departments`, `/districts?departmentCode=`, `/cities?districtCode=` | Filtered by parent, so no endpoint returns the full city list |
| Open: scope required by the catalog endpoints (none beyond a valid key vs `documents:read`) | Decide in the ADR |
| Open: dataset location (`packages/sifen-xsd/vendor` vs a new module of `fiscal-config`) | Decide in the ADR |

## Tasks

- [x] T0 Obtain the geographic file and record its source, date and checksum. Public download, no login (see Evidence). The file is NOT committed in slice A; it is kept at `/tmp/claude-1000/geo-source/geo.xlsx` for slice B.
- [x] T1 ADR-0017: receiver address contract and geographic catalog ownership (resolve the two open decisions).
- [x] T2 Contract alignment: optional address block, conditional rules, B2F rules, `location.departmentCode` optional; domain tests first.
- [x] T3 Confirm how the TIPS builder emits B2F and optional address; adjust `invoice-xml.ts` so `cDepRec` and `cCiuRec` are omitted for B2F and the receiver block omits absent fields. XSD check on the generated XML.
- [x] T4 Vendor the catalog (generation script or reviewed conversion, checksum test, README entry) and remove the stale claim in `department.ts`.
- [x] T5 Catalog validation: district and city exist, city belongs to district, district belongs to department, descriptions match codes; new `ValidationError` rules with SIFEN codes.
- [x] T6 Read endpoints with OpenAPI regeneration (`pnpm --filter @sifen/api openapi`) and Fastify `inject()` e2e tests.
- [ ] T7 Docs: update `docs/integracion/emision.md` (address optional, B2F, catalog endpoints), `docs/api`, and the PR descriptions.
- [ ] T8 Operational check: confirm optional address and B2F with the Prevalidador and record the evidence.

## PR slices (chained, each about 400 changed lines or less)

| PR | Content | Depends on |
|---|---|---|
| A | T1 (ADR) + T2 + T3: contract alignment, no catalog needed | none |
| B | T4: vendored catalog, checksum test, source note | T0, A |
| C | T5: catalog validation | B |
| D | T6: read endpoints | B |
| E | T7: docs | A, C, D |

A can start immediately. B to D wait for T0. The vendored dataset in B is generated data and is declared as
such in the PR description.

## Route declaration

- T0: inline (web fetch of one public page, one download).
- T1: inline (one document plus a one-line README entry).
- T2, T3: delegated, one writer (writer trigger: 6 non-trivial source files plus their specs); split into A1 and A2 to stay under 400 lines. TDD strict (source: `openspec/config.yaml`), runner Vitest.

## Acceptance criteria

- A named receiver without address is accepted for B2B, B2C and B2G; the XML omits the address fields.
- With an address, house number, department and city are required unless B2F; with B2F they are rejected, and
  the address is required.
- An unknown district or city, a city outside its district, or a description that does not match its code is
  rejected with `422` and the rule name before any number is burned.
- The three catalog endpoints return filtered lists, require a valid API key and appear in the OpenAPI.
- `pnpm check` and the coverage thresholds pass; the OpenAPI test passes after regeneration.

## Progress and next step

- Done: gap analysis; T0 (file obtained); T1 (ADR-0017 accepted, both open points resolved: catalog endpoints
  need only a valid API key, dataset goes in `packages/sifen-xsd/vendor`); T2 and T3 (A1, A2).
- Next: slice B (T4: convert and vendor the file, checksum test). It needs the tech lead to place the file.

## Checks and evidence

- T0 source: page `https://www.dnit.gov.py/en/web/e-kuatia/tablas-y-codificaciones` (DNIT, Tablas y codificaciones).
  File `CÓDIGO DE REFERENCIA GEOGRAFICA_NOVIEMBRE_2025__.xlsx` (single sheet "División Político-Administrativ"),
  URL `https://www.dnit.gov.py/documents/20123/420592/C%C3%93DIGO+DE+REFERENCIA+GEOGRAFICA_NOVIEMBRE_2025__.xlsx/baf35d49-b6d2-406b-de70-a1d9f63e9e32?t=1769521630085`.
  Downloaded 2026-10-13, 469941 bytes, SHA-256 `3918fc3517ce0b5ae883648b9316bbb2583c1b49e614d51d8b441dae978abc16`
  (MD5 `0d817dee1a6a0c307a8fd25140c4f9be`). The page lists only this version. It also links a "Checksum MD5"
  PDF dated 2023 (older than the file); it was not compared, so integrity against DNIT is unverified.
- T2/T3 RED: `invoice-draft.spec.ts` 7 failed | 21 passed before the rules; `create-document.request.spec.ts`
  10 failed | 36 passed before the optional block and `toInvoiceDraft`; `invoice-xml.spec.ts` 6 failed | 24 passed
  before the mapper change. GREEN after each implementation. The signing-store and e2e cases were added after the
  implementation (not observed RED).
- T3 findings: `xmlgen` already omits `cDepRec`/`cDisRec`/`cCiuRec` for `tipoOperacion = 4` and every address
  field when `direccion` is absent; the mapper now also withholds them explicitly. B2F XML still cannot be built
  because `xmlgen` requires a foreign non-contributor receiver (the API only models RUC receivers). B2G XML cannot
  be built either (`dEntCont`), with or without an address; both are pre-existing and out of scope.
  `xmlgen` also overwrites department and district from the city using its own table (reconcile in slice C).
- Pending: Prevalidador confirmation for B2F and optional address (T8).
- T4 (slice B): `packages/sifen-xsd/scripts/build-geo-catalog.ts` + `geo-catalog.ts` (pure parsing, unit tested; RED first for parsing and `refresh-xsd` keeping datasets). Dataset 18 departments / 272 districts / 6766 cities, department names equal `Departamentos_v141.xsd`. Workbook not committed (no explicit license); pinned by SHA-256. The 2023 MD5 PDF (`80733BB1C4834C9C2ABBBF3C194D1566`) does not cover the 2025 file. Existing fixtures use city 3432 / district 145, which exist in the table.

## Debt (slice B review, input is SHA-pinned)

- Zip reader: no `maxOutputLength` on inflate, no ZIP64 or CRC check.
- Sheet parser: phonetic runs (`rPh`) in shared strings and numeric XML entities are not handled.

## Slice D (T6) record

- Route: delegated direct, one writer (writer trigger: new module plus package loader, spec and OpenAPI). TDD strict, runner Vitest.
- RED observed: `load-geo-catalog.spec.ts`, `geo-catalog.spec.ts` and `geo-query.spec.ts` failed on missing modules; `test/geo.e2e.spec.ts` 5 failed | 1 passed with `GeoModule` unwired; `openapi.spec.ts` 2 failed (undocumented routes) plus the checked-in `openapi.json` drift. GREEN after each.
- Decisions: `GET /v1/geo/departments|districts|cities`, API key only (no scope, ADR-0017), `{ items: [...] }`; missing or malformed parent 400, unknown parent 404. Loader `loadGeoCatalog()` lives in `@sifen/sifen-xsd` next to the vendored data.

## Slice C (T5) record

- Route: delegated direct, one writer. TDD strict, runner Vitest. Split in two chained PRs (C1 acceptance rules, C2 XML).
- Finding: `xmlgen`'s tables equal the November 2025 catalog except district 289 (xmlgen "PUERTO ADELA", DNIT "LAUREL"). `xmlgen` derives receiver department and district from the city (overwriting what is passed) and takes the issuer department/district/city text from its own table, never from the establishment. For documents whose codes nest in the catalog the XML is therefore byte-identical (golden hash `e12a73...cd66` unchanged); the only difference is district 289.
- Rules (acceptance only, `validateGeo`): `receiver-district-unknown`, `receiver-city-unknown`, `receiver-city-not-in-district`, `receiver-district-not-in-department`, `receiver-city-not-in-department` (no district informed), `receiver-district-description-mismatch` (1325), `receiver-city-description-mismatch` (1329). Signing uses `signingValidationConfig()` (catalog text, no catalog checks) so documents accepted before these rules still sign; their department/district keep the value `xmlgen` derives.
- Behaviour change: a receiver whose district is not in the informed department is now a 422. Test fixtures that sent department 11 with Asuncion's district/city now send department 1.
- XML: `generateInvoiceXml` writes the catalog description for the code the XML carries (receiver and issuer) and, for validated drafts, fails on a code `xmlgen` changed (`cCiuRec is X but the validated code is Y`).
- RED observed: `geo-catalog.spec.ts` lookups 1 failed; `invoice-draft-geo.spec.ts` 6 failed | 3 passed; `create-document.request.spec.ts` 1 failed; `invoice-xml.spec.ts` 3 failed (district 289 receiver, district 289 issuer, override detection) and 1 more for the legacy signing case; `documents-geo.e2e.spec.ts` 6 failed with the rules switched off.
- Review fixes (C1): descriptions compare normalized (case, accents, spaces); only the description rules carry SIFEN codes (1325, 1329), because the norm sources in the repo define none for unknown codes or nesting.
