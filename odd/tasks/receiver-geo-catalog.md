# Receiver address contract and geographic catalog

- Feature: `receiver-geo-catalog` · Refs: HU-E5-08 (F2; integration gap found while documenting `POST /v1/documents`)
- Engram mirror: `odd/receiver-geo-catalog/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`, thresholds 85%)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; each PR about 400 changed lines or less (advisory), generated data declared per PR.
- Status: planned, nothing implemented. No source change has been made.

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

- [ ] T0 Obtain `CODIGO DE REFERENCIA GEOGRAFICA.xlsx` from the e-Kuatia portal and record its source, date and checksum. **Blocked on a person with portal access.**
- [ ] T1 ADR-0017: receiver address contract and geographic catalog ownership (resolve the two open decisions).
- [ ] T2 Contract alignment: optional address block, conditional rules, B2F rules, `location.departmentCode` optional; domain tests first.
- [ ] T3 Confirm how the TIPS builder emits B2F and optional address; adjust `invoice-xml.ts` so `cDepRec` and `cCiuRec` are omitted for B2F and the receiver block omits absent fields. XSD check on the generated XML.
- [ ] T4 Vendor the catalog (generation script or reviewed conversion, checksum test, README entry) and remove the stale claim in `department.ts`.
- [ ] T5 Catalog validation: district and city exist, city belongs to district, district belongs to department, descriptions match codes; new `ValidationError` rules with SIFEN codes.
- [ ] T6 Read endpoints with OpenAPI regeneration (`pnpm --filter @sifen/api openapi`) and Fastify `inject()` e2e tests.
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

Each task will be recorded here as inline or delegated when it starts, with the trigger evidence. T2 and T3
touch 2 or more non-trivial files and the generated XML path, so they are expected to use one delegated writer.

## Acceptance criteria

- A named receiver without address is accepted for B2B, B2C and B2G; the XML omits the address fields.
- With an address, house number, department and city are required unless B2F; with B2F they are rejected, and
  the address is required.
- An unknown district or city, a city outside its district, or a description that does not match its code is
  rejected with `422` and the rule name before any number is burned.
- The three catalog endpoints return filtered lists, require a valid API key and appear in the OpenAPI.
- `pnpm check` and the coverage thresholds pass; the OpenAPI test passes after regeneration.

## Progress and next step

- Done: gap analysis against Manual Tecnico v150 and NT 003, 010, 014 and 017.
- Next: T0 (obtain the geographic file) and T1 (ADR). PR A needs neither the file nor a decision on the
  two open ADR points beyond what is listed above.

## Checks and evidence

- None run yet. Pending: Prevalidador confirmation for B2F and optional address (T8).
