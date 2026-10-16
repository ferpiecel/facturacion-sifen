# Electronic credit note (NCE) associated with an FE

- Feature: `hu-e7-01-credit-note` · Refs: HU-E7-01 (F2, first story of epic E7; RF-01)
- Engram mirror: `odd/hu-e7-01-credit-note/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`, thresholds 85%)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; each PR about 400 changed lines or less (advisory).
- Size: **XXL, 8 points** (see "Sizing"). Target 60M raw tokens, alarm 100M, hard stop 150M.
- Status: slice A (ADR-0019 and TIPS spike) in review; slice B (migration) in a draft PR. No emission code changed. Code starts only after the
  prerequisites in "Ordering against in-flight features" have merged.

## Objective

Let an integrator issue an NCE (`iTiDE` 5, C002) associated by CDC with an FE the tenant already issued
and SIFEN approved, through the same asynchronous flow as the FE (202, numbering, signing, QR, lote
transmission, webhooks, KuDE). The platform must refuse before burning a number what SIFEN would refuse
later: credits that exceed the FE (2417), a different currency (2438, a guard while only PYG exists), an unknown, cancelled or foreign FE.

## Problem (gap analysis)

### What the pipeline does today (FE only)

| Stage | Where | FE-specific hardcoding found |
|---|---|---|
| Request contract | `emission/infrastructure/http/create-document.request.ts`, `documents.controller.ts` | One schema for `POST /v1/documents`; no document type field. The stored `payload` is this body. |
| Draft validation | `emission/domain/invoice-draft.ts` | `InvoiceDraft` has receiver, `operationType`, items, `roundingPyg`, department. PYG-integer rule, 50 Gs rounding, innominado threshold (1321), OEE rule (1332). No notion of an associated document or a reason. |
| Acceptance | `emission/application/accept-invoice.ts` | `INVOICE_DOCUMENT_TYPE = 1` constant; validates, resolves issuer, `nextNumber(issuer, 1)`, random `dCodSeg`, `buildCdc` with type `01`, inserts `documents`, audits, idempotency by key + request hash. `netTotal` = items − rounding is stored as `total_amount` (this is F014). |
| XML | `emission/application/invoice-xml.ts` | `mapInvoiceToXmlInput` fixes `tipoDocumento: 1`, `tipoTransaccion: 1`, `factura: { presencia }`, `condicion` (contado, one `entrega`), unnamed receiver unsupported. `generateInvoiceXml` hardcodes `documentType: '01'` in the CDC cross-check. |
| Signing and QR | `invoice-signing.ts`, `invoice-qr.ts`, `sign-document.ts`, `infrastructure/drizzle-signing-store.ts` | Type-agnostic except that the store re-parses `documents.payload` with the FE schema (`parseCreateDocument` plus `xmlDetailSchema`), so an NCE payload would fail with `SigningDataIncompleteError`. The QR reads `dTotGralOpe`, `dTotIVA`, receiver; it works on any DE. |
| KuDE | `domain/kude-model.ts`, `application/kude-reader.ts`, `infrastructure/kude/pdfkit-kude-renderer.ts` | `KUDE_TITLE` is the FE title; `readKudeInvoice` throws `iTiDE: unsupported` when it is not 1; it requires `gCamCond` (absent in an NCE); no associated document or reason on the model. |
| Numbering | `packages/db/src/document-number.ts` | Sequence key already includes `documentType`; accepts 1..8. `documents`, `lotes` and sequences have CHECK 1..8. No change needed for type 5. |
| Transmission | `transmission/domain/lote-builder.ts`, `assemble-lotes.ts` | A lote holds one issuer and one type (`type-mismatch`; plan v1.0 requires one issuer and one type per lote) and already derives the type from the CDC. NCE gets its own lotes with no code change; a test must prove it. |
| Portal and webhooks | `portal-documents/domain/document-type.ts` | `NCE: 5` is already mapped for listing and filtering. |

### What changes for the NCE

- `C002 iTiDE` = 5, `C003` = "Nota de crédito electrónica"; CDC type `05`; own numbering sequence.
- **Associated document (H, `gCamDEAsoc`)**: mandatory, exactly once (2400, 2415). `H002 iTipDocAso` = 1
  (electrónico), `H004 dCdCDERef` = CDC of the original FE. The CDC must belong to an FE (`01`), to the same
  issuer (2439) and to the same receiver (2441).
- **Reason (E5, `gCamNCDE`)**: `E401 iMotEmi` 1..8 and `E402 dDesMotEmi` (the description fixed by the code).
  Mandatory for C002 = 5 (1450).
- **Groups that must not be informed**: `D011 iTipTra` (only C002 = 1 or 4), `E600 gCamCond` (only C002 = 1
  or 4), `E010 gCamFE` (only C002 = 1), `E900 gTransp` and the exit/delivery locations (2101, 2201 for
  C002 = 4, 5, 6, 8). Today's mapper emits `tipoTransaccion`, `factura` and `condicion` unconditionally.
- **Mandatory D010 `gOpeCom`** with `D013 iTImp` and `D015 cMoneOpe` (no D011).
- **Items (E8) and totals (F)**: same structure as the FE; `F014` = F008 − F011 − F012 − F013 (2365, valid for
  C002 = 1, 5, 6). So today's totals and rounding logic is reused as is.
- **Receiver**: an innominado receiver is not allowed (D208 ≠ 5, 1331, NT 010 and NT 023). An FE issued to
  "Sin Nombre" therefore cannot get an NCE until it is nominated (event of Nominación, NT 015 validation 2442).
- **KuDE**: denomination "KuDE de Nota de Crédito Electrónica" (MT 13.3); the reference layout is Gráfica N° 10
  (MT 13.5). It shows no payment condition (E7 is absent) and has to show the associated document.
- **Automatic SIFEN event**: approving an NCE generates the "Devolución y Ajuste de precios" event on the FE
  (MT 11.1.3). The FE needs no action from us, but the FE's SIFEN state changes; document it.

## Normative basis

Precedence follows ADR-0012 (technical notes > Guía de Pruebas 2026 > best-practices guide 2024 > MT v150 >
examples). All citations are to `docs/referencia/dnit/`.

| Rule | Source | Platform check |
|---|---|---|
| C002 = 5 NCE; C003 description | MT v150, group C, fields C002/C003 | Constant for the type |
| H001 `gCamDEAsoc` 0-99, mandatory if C002 = 4, 5, 6; error 2400 | MT v150, group H, validation 240; NT 023 sec. 2.2 | Required in the contract |
| NCE group occurs once, 2415 | MT v150, validation 242 (H001b) | One association only |
| H002 = 1 requires H004 (2402); H004 forbidden for H002 = 2 or 3 (2418) | MT v150, validations 243 to 249 | Always H002 = 1 |
| FE-only association for NCE and NDE (no other document type) | MT v150, validation 241 (H001a, 2414) | Reject a CDC that is not `01...` |
| H002 ≠ 3 for C002 = 1, 5, 6, 7, 2434 | MT v150, validation 244 | Not applicable (constancia is never sent) |
| H004a CDC must exist, 2403; H004b CDC not cancelled, 2404 | MT v150, validations 247 and 248 | Pre-check against our `documents` (status approved, not `cancelled`) |
| **H004d sum of NCE F014 (current and pre-existing) must not exceed F014 of the FE, 2417** | MT v150, validation 250 | Pre-check with a row lock (see decisions) |
| **H004f same operation currency (D015 of the FE equals D015 of the NCE), 2438** | MT v150, validation 252 | Pre-check; trivially true while only PYG exists, keep the check for multi-currency |
| H004g CDC must belong to the issuer of the NCE (and the merged RUC), 2439 | NT 010 sec. 2.3; NT 023 sec. 2.2 | Pre-check; `H018 dRucFus` (2443, 2444) is out of scope |
| H004h CDC must match the receiver of the NCE, 2441 | NT 010 sec. 2.3 | Receiver is taken from the FE (decision) |
| H004i receiver must match the Nominación event, 2442 | NT 015 sec. 1.1 | Only relevant for nominated FE; out of scope |
| E400 `gCamNCDE` mandatory if C002 = 5 or 6 (1450); forbidden otherwise (1451) | MT v150, group E5, validations 92 and 93 | Reason is required for the NCE only |
| E401 `iMotEmi` 1..8; E402 description matches (1452) | MT v150, group E5, fields E401/E402 | Closed enum in the contract; description from a table |
| D010 `gOpeCom` mandatory unless C002 = 7; D011 only if C002 = 1 or 4 (1202) | MT v150, group D1 | Never send `iTipTra` in an NCE |
| D013 `iTImp` and D015 `cMoneOpe` mandatory | MT v150, group D1 | Same values as the FE |
| E600 `gCamCond` mandatory only if C002 = 1 or 4 (1500, 1501) | MT v150, group E7, validations 102 and 103 | Omit for NCE |
| E900 transport not allowed for C002 = 4, 5, 6, 8 (2101); delivery location not allowed (2201) | MT v150, validations 169 and 185 | Never emitted |
| F014 = F008 − F011 − F012 − F013 for C002 = 1, 5, 6 (2365) | MT v150, group F, validation 223 | Existing totals logic |
| Receiver not innominado for C002 = 5 or 6 (1331); innominado only for B2C (1319, 1333) | NT 010 sec. 2.1; NT 023 sec. 2.1 | Reject an NCE whose FE has an unnamed receiver |
| Reference layouts and denomination of the NCE KuDE | MT v150, sections 13.3, 13.5 (Gráfica N° 10) | KuDE title and associated document block |
| FE must be delivered, transmitted and approved; no VAT credit for the receiver on adjusted FE; automatic "Devolución y Ajuste de precios" event; keep 5 years | MT v150, section 11.1.3 | Association requires `approved`; document the retention |
| Test battery: NCE 5 approved + 5 rejected on the sync web service, same on the async one; 1 NCE number voiding | Guía de Pruebas e-Kuatia 2026-02, sections 4.2 and 4.3 | T11 (blocked on environment) |

Gaps in the sources, to confirm in T0 and not assumed: whether SIFEN accepts an NCE that references an FE
in `approved_with_observations`; whether SIFEN counts a rejected NCE in 2417 (our rule, D5: it does count, because it is resent with the same CDC; only `cancelled` and `number_voided` release credit); whether the
timbrado of the NCE is validated per document type (the platform resolves one timbrado per tenant,
`drizzle-acceptance-unit-of-work.ts`); the exact content of Gráfica N° 10 (the MT page is an image).

## What the TIPS library supports

Read from `facturacionelectronicapy-xmlgen@1.0.283` (`dist/services/jsonDeMain.service.js`,
`jsonDeMainValidate.service.js`, `jsonDteIdentificacionDocumento.service.js`) and from
`packages/sifen-tips/src/de-xml-builder.ts` (a thin port adapter; it passes `params` and `data` through).

- `tipoDocumento` 5 and 6 are first-class. `data.notaCreditoDebito.motivo` (1..8) emits `gCamNCDE` with
  `iMotEmi` and `dDesMotEmi`. `data.documentoAsociado` (an object, or an array) emits `gCamDEAsoc`; with
  `formato: 1` and a `cdc` of 44 characters it writes `iTipDocAso`, `dDesTipDocAso` and `dCdCDERef`
  (`dRucFus` only when `rucFusionado` is given for types 5, 6, 7).
- `gCamCond` is generated and validated only for types 1 and 4, `iTipTra` only for 1 and 4, `gCamFE` only for 1,
  transport only for 1 and 7, and the totals group for all but 7. This matches the MT groups above.
- The validator makes `documentoAsociado` mandatory for 4, 5, 6. It checks `tipoTransaccion` against the table
  even when the type does not emit it (`jsonDeMainValidate.service.js`, around line 360), so the adapter probably
  has to pass a valid value that the library then ignores. To be proven in T2.
- The library does not check the association semantics (existence, issuer, receiver, sum, currency); those are
  ours. It does not render a KuDE; ours is `pdfkit-kude-renderer.ts`.
- Not yet proven: the XML that results from `tipoDocumento: 5` passes `siRecepDE` XSD validation and carries no
  `gCamCond`, `gCamFE`, `iTipTra`. T2 settles it with an offline test before any platform code.

## Ordering against in-flight features

Both features are planned only (`origin/main` has docs commits, no code). They change the files NCE needs.

| Feature | Files it changes that NCE also needs | Effect on NCE |
|---|---|---|
| `receiver-geo-catalog` (HU-E5-08, ADR-0017) | `create-document.request.ts` (receiver becomes optional, conditional rules), `invoice-xml.ts` (receiver block omits absent fields), `drizzle-signing-store.ts` (`xmlDetailSchema` for the stored payload) | The NCE takes the receiver from the original FE's stored payload (decision D3), so the stored payload shape must be the final one. Slice A (contract and XML) is the prerequisite; slices B to E (catalog) are independent of NCE. |
| `decimal-precision` (HU-E5-09, ADR-0018) | `invoice-draft.ts` (math and the `pyg-integer` rule), `accept-invoice.ts` (`netTotal`, stored `total_amount`), then `invoice-xml.ts`, QR, `kude-reader.ts` and the renderer (slice D) | The 2417 sum rule compares F014 values of several documents. It must use the `Decimal` value object and the new totals. |

**Order: NCE starts its code (slice C onward) after decimal-precision slice C merges, and after
receiver-geo-catalog slice A.** Reasons:

1. The 2417 rule is exact money arithmetic across documents. Writing it on `number` and migrating it later
   would put a floating-point comparison in a fiscal rule (a sum that should equal the FE total could be
   refused or admitted by one unit) and would be rewritten by decimal slice C anyway.
2. NCE reuses `validateInvoiceDraft` for items, rounding and totals and reads `total_amount` as the FE total.
   Decimal slice C rewrites those functions and the `netTotal` computation; starting earlier forces rebases
   on exactly the lines NCE extends.
3. The invariant of decimal-precision (documents accepted today stay byte identical) is easiest to keep if the
   NCE branch is added once, after the domain math is stable, instead of in two moving versions.
4. The XML, QR and KuDE slices of NCE (E and F below) also wait for decimal slice D, because it changes
   `invoice-xml.ts`, `kude-reader.ts` and the renderer that those slices generalize.

What can start now, without touching those files: the ADR, the TIPS spike (tests only) and the migration
(slices A and B). ADR numbers: 0017 and 0018 are reserved by the two features; this one is **ADR-0019**.

## Scope

In: NCE for an FE of the same tenant and environment, in PYG, associated by CDC (H002 = 1); reasons 1..8;
numbering, acceptance, idempotency, signing, QR, lote transmission, KuDE, portal listing check, webhooks,
OpenAPI and guide; pre-checks for 2403, 2404, 2417, 2438, 2439, 2441, 1331.

Out: NDE (HU-E7-02), AFE (E7-03), NRE (E7-04); association with a printed document (H002 = 2) or to
an FE not issued by the platform; foreign currency and exchange rate (`multi-currency` follow-up);
`H018 dRucFus`; the Nominación event; cancelling or voiding an NCE (E8, E9); NCE of an unnamed-receiver FE.

## Constraints

- Strict TDD: failing test first, then code, with observed RED and GREEN recorded per task.
- Hexagonal rules hold: association lookup and the sum are a port in `application/ports/`, implemented in
  `infrastructure/` with Drizzle under `withTenantTransaction`; the rules are pure functions in `domain/`.
- Backward compatible: an existing `POST /v1/documents` body (no type) is an FE and produces byte-identical
  XML, totals and KuDE. Stored payloads of existing FEs have no discriminator and must keep parsing.
- A refused NCE burns no number: all pre-checks run before `nextNumber`, inside the transaction so a rollback
  also undoes anything taken (same pattern as the FE).
- The sum rule must be race-safe: two concurrent NCEs for the same FE cannot both pass.
- Only `packages/sifen-tips` imports the TIPS libraries (ADR-0015); the gateway port stays opaque.
- No new dependency. No credentials in tests; test PKI only.

## Technical decisions (to record in ADR-0019; open ones are marked)

| # | Decision | Rationale |
|---|---|---|
| D1 | Same endpoint `POST /v1/documents` with a `type` discriminator (`FE` default, `NCE`) | Keeps ADR-0011 (202, `Idempotency-Key`), controller, idempotency and OpenAPI path; the default keeps old bodies valid. **Open**: a separate `POST /v1/credit-notes` is cleaner for OpenAPI and for scopes but doubles the idempotency wiring. Decide in the ADR. |
| D2 | The NCE request carries `associatedCdc`, `reasonCode` (1..8), items and `roundingPyg`; establishment and expedition point as the FE | Minimal surface; mirrors the API's flat naming |
| D3 | The receiver is **not** in the request; the platform copies it from the stored payload of the FE | 2441 is satisfied by construction and the integrator cannot send inconsistent data. Cost: depends on the FE payload shape (hence after geo slice A). **Open**: accept an optional receiver and compare. |
| D4 | Association is stored in a new nullable column `documents.associated_cdc char(44)` plus an index on (`tenant_id`, `environment`, `associated_cdc`) and a CHECK `^[0-9]{44}$`; that it must belong to an FE (`01...`) is a domain rule (2414), not a database one | Cheap and queryable for the sum; the `documents` table already has RLS. **Open**: a link table is more general for NDE and AFE but adds RLS surface; the NDE shares the same shape so the column is likely enough. |
| D5 | The sum is computed in one query under `SELECT ... FOR NO KEY UPDATE` on the FE row (ADR-0019: serializes NCEs without blocking child FK inserts or the `FOR UPDATE` of createLote), summing `total_amount` of documents with that `associated_cdc`, type 5 and status not in (`cancelled`, `number_voided`) | Serializes concurrent NCEs on the same FE. **Decided**: only `number_voided` and `cancelled` release credit; `rejected` and `corrected` still count because they are resent with the same CDC (plan v1.1 sec. 8.0). |
| D6 | The FE must be `approved` or `approved_with_observations` (**open**: the second, see T0) and not `cancelled` | MT 11.1.3: the NCE needs an FE already approved by SIFEN; 2403 and 2404 |
| D7 | Rules are named like the FE ones (`rule` plus `sifenCode`): `credit-note-sum-exceeds-invoice` (2417), `credit-note-currency-mismatch` (2438), `associated-document-not-found` (2403), `associated-document-cancelled` (2404), `associated-document-not-approved` (the FE exists but SIFEN has not approved it yet; distinct from 2403, no SIFEN code), `associated-document-not-invoice` (2414), `credit-note-unnamed-receiver` (1331) | Same 422 problem format as `validationProblem` |
| D8 | Generalize, do not fork: `INVOICE_DOCUMENT_TYPE` and the `'01'` in `generateInvoiceXml` become a per-document type input; `mapInvoiceToXmlInput` gets a credit-note branch that omits `factura`, `condicion` and sets the `notaCreditoDebito` and `documentoAsociado` blocks | Avoids a second pipeline; changes are guarded by the byte-identical FE test |
| D9 | `tipoTransaccion` is passed to the TIPS validator but never emitted for NCE (to confirm in T2) | See library notes |
| D10 | KuDE: same renderer with a type-aware title and an "associated document" block; the reader dispatches on `iTiDE` and reads `gCamNCDE` and `gCamDEAsoc`; `gCamCond` becomes optional | One renderer, MT 13.3 titles |
| D11 | Reasons table (code to description) lives in `domain/` as a constant checked against the MT list | Required by 1452 |

## Tasks

- [ ] T0 Research and evidence: settle the gaps listed in "Normative basis"; extract the NCE KuDE content from the MT (Gráfica N° 10); confirm with the Prevalidador or test environment an NCE without D011 and E600, and a reference to an FE with observations. **Blocked on test environment access and a certificate.** The sub-items about internal state (D5) are not blocked.
- [x] T1 ADR-0019 (done in PR A, `docs/adr/0019-nota-de-credito-asociada-a-una-factura.md`; also closes D9 and P4): NCE contract, association storage, sum concurrency, receiver derivation; resolve D1, D3, D4, D5, D6.
- [x] T2 TIPS spike (done in PR A, `packages/sifen-tips/test/nce-type5.e2e.spec.ts`; the type 5 XML validates against siRecepDE) (tests only, offline): build a type 5 document with `notaCreditoDebito` and `documentoAsociado`, validate against `siRecepDE`, assert the absent groups, record the `tipoTransaccion` behavior (D9).
- [x] T3 (done in PR B: migration `0046_documents_associated_cdc`, with a separate immutability trigger and extra CHECKs) Migration `0046` (or next free): `documents.associated_cdc` with CHECK and index, rollback script, Drizzle schema, RLS coverage test stays green (no new table), `db-postgres` run.
- [x] T4 (PR C1, `credit-note-draft.ts`; takes the FE facts as input, lookups stay in slice D) Domain: `credit-note-draft` types, reasons table, `validateCreditNoteDraft` (items and rounding reuse the invoice rules, unnamed receiver 1331), pure `creditNoteSumRule` and currency rule over `Decimal`. Tests first.
- [x] T5 (PR C2, `credit-note.request.ts`; the controller answers 422 `document-type-not-supported` until slice D) Request contract: `type` discriminator, NCE schema, mapping to the use case input, backward compatibility test with an old FE body, OpenAPI regeneration.
- [x] T6 (PRs D1 and D2: use case, port methods, Drizzle unit, `associated_cdc`, controller behind a gate, signing store hold) Application and persistence: `acceptCreditNote` use case and `AcceptanceUnit` port methods (`findAssociatedInvoice` with lock, `sumCreditNotes`), Drizzle implementation, numbering type 5, CDC `05`, audit action, idempotency, all checks before `nextNumber`. Concurrency test (two simultaneous NCEs).
- [x] T7 (PR E: `ctx.creditNote` in `invoice-xml.ts`, store dispatch by type, gate removed; QR unchanged) Signing path: signing store dispatches on type, builds the NCE context (reason, associated CDC, receiver from the FE), `invoice-xml.ts` credit-note branch (D8), CDC type from input, XSD check, QR unchanged. FE byte-identical test.
- [x] T8 (PR F: reader, model and renderer for iTiDE 5; the FE PDF hash is pinned) KuDE: reader supports `iTiDE` 5, model and renderer title and associated document block, `gCamCond` optional; golden text assertions as the FE ones.
- [x] T9 (PR F: lote-builder test; no code change was needed) Transmission and events: test that NCE documents form their own lotes and are sent; webhook payloads and portal listing show `NCE`; no code change expected, confirm.
- [x] T10 (PR F: `docs/integracion/emision.md`, OpenAPI regenerated) Docs: `docs/integracion/emision.md` section on NCE (contract, reasons, errors 2417 and 2438, innominado limit), `docs/api/openapi.json`, backlog and roadmap status.
- [ ] T11 End to end and battery: FE accepted and approved (simulator) then partial NCE (202, signed); second NCE over the limit (422 rule 2417, no number consumed); then the Guía de Pruebas battery of 5 approved and 5 rejected NCE on both web services. **The battery is blocked on environment access**; the "rejected" cases need a dev/test-only path that bypasses local pre-checks (decided in ADR-0019).

## PR slices (chained, each about 400 changed lines or less)

| PR | Content | Estimated size | Depends on |
|---|---|---|---|
| A | T1 ADR-0019 + T2 TIPS spike tests (+ T0 results that are not blocked) | about 300 | none |
| B | T3 migration, schema, rollback, tests | about 200 | A |
| C | T4 + T5 domain rules and request contract (the `type` discriminator in the schema) | about 400 | B, **decimal-precision C**, **receiver-geo-catalog A** |
| D | T6 use case, ports, Drizzle unit of work, concurrency test | about 400 (split in two if over budget: use case, then persistence) | C |
| E | T7 XML branch, signing dispatch, FE byte-identical test | about 350 | D, **decimal-precision D** |
| F | T8 KuDE reader, model, renderer | about 300 | E |
| G | T9 + T10 + T11 transmission check, docs, OpenAPI, end to end | about 350 | F |

A and B may merge while decimal-precision and geo-catalog are still in flight, because they touch only
`docs/`, `packages/sifen-tips` tests and `packages/db`. Generated `docs/api/openapi.json` is declared as
generated in the PR description. Total about 2,300 authored lines including tests and docs.

## Sizing

Team table (points): expected authored lines about 2,300 gives 4 (2,000 to 3,500); layers touched three or
more (domain, application, infrastructure, plus docs and package `db`) gives 2; migration gives 1;
sensitive area (signing flow, idempotency and the numbering of a fiscal document) gives 1. Total **8 points,
XXL**: target 60M, alarm 100M, hard stop 150M raw tokens. The planning PR itself is docs only. Record
cumulative tokens at each PR merge; at the alarm, re-plan once (the first candidate to cut is the T11
battery, which is blocked on the environment anyway, not the sum rule or the review fixes).

## Route declaration

Recorded per task when it starts. Expected: T1, T2 and T3 inline or one writer each (each is one or two
non-trivial files); T4 to T8 one delegated writer per PR with the writer reading the plan and ADR first
(each touches 2 or more non-trivial files across layers); T9 an inline check; T10 one writer; T11 split
between a writer for the automated tests and the PO-assisted battery. Mapping of the emission module for
slice E (4 or more files) goes to one narrow exploration worker before writing. Tests, builds and the
Postgres run use fresh per-action workers.

## Acceptance criteria

- Given an approved FE of 1,000,000 PYG, an NCE of 400,000 PYG with its CDC is accepted: 202 with a 44-digit
  CDC starting `05`, document in `accepted` and then `signed`, with `associated_cdc` stored.
- After NCEs totalling 700,000 PYG, another of 400,000 PYG answers 422 with rule `credit-note-sum-exceeds-invoice`
  and SIFEN code `2417`, and no number is consumed. Two concurrent NCEs whose sum exceeds the FE: exactly one
  is accepted.
- Currency stays PYG-only (consistent with `decimal-precision`; multi-currency is a follow-up), so 2438 is unreachable today and remains as a guard with a unit test. An unknown CDC, a cancelled FE, a CDC
  of another type, another issuer or another tenant answers 422 with the matching rule (2403, 2404, 2414,
  2439), an FE not yet approved answers `associated-document-not-approved`, and nothing leaks across tenants.
- An FE issued to an unnamed receiver cannot be credited (rule `credit-note-unnamed-receiver`, 1331).
- The generated NCE XML validates against the vendored `siRecepDE` XSD, carries `iTiDE` 5, `gCamNCDE`,
  `gCamDEAsoc` with `dCdCDERef`, and no `gCamCond`, `gCamFE`, `iTipTra`.
- The NCE is transmitted in its own lote and the KuDE shows the NCE title, the reason and the associated FE.
- Every request that is accepted today (FE) produces byte-identical XML, totals and KuDE.
- `pnpm check`, `pnpm --filter @sifen/db test:postgres` and the coverage thresholds pass; the OpenAPI test
  passes after regeneration.

## Decisions

Decided (the review found no product decision left):

- P1 expose all eight reasons: MT E401/E402 and 1452 define one closed table.
- P2 an FE issued to "Sin Nombre" cannot be credited until HU-E8-05 (Nominación): SIFEN refuses with 1331 (NT 010, NT 023).
- P3 pre-printed or externally issued FE are out: they cannot satisfy 2403, 2404, 2417 or 2439 and the MT 11.1.3 pre-printed coexistence was only for the pilot.
- D5 only `number_voided` and `cancelled` release credit in the 2417 sum.
- Currency is PYG-only; 2438 is kept as an unreachable guard.

Closed in ADR-0019 (technical, tech lead): D1 same endpoint with a `type` discriminator, D3 receiver copied from the FE, D4 `associated_cdc` column, D6 `approved` and `approved_with_observations` can be credited (confirm in T0), D9 `tipoTransaccion` omitted (the spike showed the library does not require it for type 5), P4 CLI-only path guarded by `NODE_ENV` and test environment. Previously open: D1 endpoint shape, D3 receiver derivation versus accepting it, D4 association storage (column versus link table), D6 whether an FE `approved_with_observations` can be credited, D9 `tipoTransaccion` handling, and P4 the dev/test-only path to produce the battery's five rejected NCE.

## Progress and next step

- Done: gap analysis over the emission module, the Manual Técnico v150 (groups C, D1, E5, E7, F, H, 11.1.3, 13),
  NT 010, 015, 023, the Guía de Pruebas 2026 and the installed `facturacionelectronicapy-xmlgen@1.0.283`;
  ordering against `receiver-geo-catalog` and `decimal-precision`.
- Next: PR A (ADR-0019 and the TIPS spike), which can start now. PR C cannot start until decimal-precision C
  and receiver-geo-catalog A have merged. T0 needs a person with test-environment access.

## Checks and evidence

- None run yet for implementation; this document changes no source. Pending: Prevalidador confirmation of the
  NCE structure (T0), the TIPS spike (T2) and the Guía de Pruebas battery (T11).

### Slice B evidence (2026-10-14)

- Route: T3 inline by the writer (schema, migration, rollback, one test block).
- RED: the 5 new `associated CDC` tests in `packages/db/test/documents.spec.ts` failed before the migration
  (column missing: `expected undefined to be null`, syntax error on the unknown column, index not found).
- GREEN: `pnpm --filter @sifen/db exec vitest run` on PGlite: 35 files, 419 passed, 20 skipped (the skips are
  the Postgres-only tests); lint, typecheck and `format:check` green.
- Shape: nullable `char(44)`; CHECKs `^[0-9]{44}$`, not equal to the own CDC, and never on an FE (type 1);
  partial index (`tenant_id`, `environment`, `associated_cdc`); trigger `documents_associated_cdc_guard`
  keeps the value immutable without rewriting `documents_guard` (0034). No new table, so the RLS coverage test
  needs no change and the existing `documents` policy covers the column.
- Covered only in the `db-postgres` job: the same suite on a real PostgreSQL 16 (`pnpm --filter @sifen/db
  test:postgres`, Docker, not run here). Rollback `rollback/0046_documents_associated_cdc.down.sql` is manual
  like the others and has no automated test.
- "Type 5 requires an association" (H001, 2400) is enforced by the domain, not by a CHECK: the column stays nullable because
  types 7 and 8 may or may not carry one.
### Slice A evidence (2026-10-14)

- Route: T1 and T2 inline by the writer (one ADR, one test file); trigger evidence: 2 files, no mapping needed.
- T2 RED/GREEN: the first run of the spike test failed 2 of 5 (regex of `gOpeCom` ignored `dDesTImp`; and the
  plan's assumption that the validator rejects a missing `tipoTransaccion` for type 5 was wrong: it builds).
  After correcting the assertions to the observed behaviour, 5/5 pass: the signed XML with QR validates against
  `siRecepDE` (`valid: true`, no errors), carries `iTiDE` 5, `gCamNCDE`, `gCamDEAsoc/dCdCDERef`, `gOpeCom`, and
  has no `gCamCond`, `gCamFE`, `iTipTra`, `gTransp`.
- `pnpm --filter @sifen/sifen-tips` test (22 passed), lint and typecheck green.

### Slice C evidence (2026-10-14)

- Route: T4 and T5 inline by the writer (two new files plus small edits). `accept-invoice.ts`, `invoice-xml.ts`,
  the KuDE and the signing store are untouched.
- RED: both new specs failed first with "Cannot find module"; the e2e NCE case failed before the controller dispatched
  on `type`; the OpenAPI spec failed on the missing `CreateCreditNoteRequest` and `oneOf`.
- The FE schema takes `type` as optional with no default, so an old body parses to the same value (same hash and payload).
- 2439 is unreachable by construction (lookup per tenant, one issuer per tenant): a foreign FE is "not found" (2403).
- Slice D must make `drizzle-signing-store` re-parse the stored payload by document type (`parseDocumentRequest`),
  or an NCE payload fails with `SigningDataIncompleteError`. Slice D also owns reading `type: "FE"` payloads.

### Slice D evidence (2026-10-15)

- Route: T6 inline by the writer, in two PRs (D1 use case and persistence; D2 controller, module gate, signing hold).
- RED: `drizzle-credit-note-acceptance.spec.ts` failed first with "Cannot find module" (no use case); the e2e
  `credit notes enabled` cases answered 422 `document-type-not-supported`; the signing store case failed on the
  missing `DocumentTypeNotSignableError`. The transmission-cycle list was extended together with the set (no separate RED).
- Gate decision: the API must not accept an NCE the worker cannot sign (XML is slice E). `CREDIT_NOTES_ENABLED` is
  a provider token fixed to `false` in `EmissionModule`; the controller answers 422 `document-type-not-supported`
  while it is off, and the e2e suite turns it on with `overrideProvider`. Slice E flips it and removes the gate.
  Defence in depth: if an NCE row ever reaches the worker, `drizzle-signing-store` throws
  `DocumentTypeNotSignableError` and the cycle holds it as `signing:DocumentTypeNotSignableError` (no retry loop).
- Concurrency: `findAssociatedInvoice` takes `FOR NO KEY UPDATE` on the FE row before `sumCreditNotes`, so a second NCE
  waits and then sees the first. PGlite is single-connection and serializes transactions, so the race test proves
  the logic (exactly one of two 600k credits on a 1M FE is accepted, number 1, no gap) but not the row lock itself;
  that needs a real Postgres (not run here).
- Slice E must replace the gate and the hold: re-parse the stored payload by document type and build the NCE XML.

### Slice E evidence (2026-10-15)

- Route: T7 inline by the writer. The NCE reuses the FE pipeline: `InvoiceXmlContext.creditNote` (reason and associated
  CDC) switches `mapInvoiceToXmlInput` to type 5 (reason and association instead of `factura` and `condicion`, D8)
  and the CDC cross-check to `05`; the store builds the draft from the NCE items plus the FE's receiver, operation
  and location (D3). `tipoTransaccion` stays as is: xmlgen never emits `iTipTra` for type 5 (D9).
- RED: `invoice-xml.credit-note.spec.ts` (type stayed 1, CDC `01`, no reason check) and `credit-note-signing.spec.ts`
  (worker path threw `DocumentTypeNotSignableError`); the e2e NCE cases answered `document-type-not-supported` while the
  gate was on. GREEN: the NCE XML validates against siRecepDE, signs with QR and is stored `signed`; the existing
  golden FE tests are unchanged.
- The `CREDIT_NOTES_ENABLED` gate is gone: NCE is live end to end. Types other than 1 and 5 are still held with
  `DocumentTypeNotSignableError`.
- KuDE: generated on demand from the signed XML (`GET /v1/documents/{id}/kude`), outside the signing and transmission
  cycle, so its `iTiDE: unsupported` error for an NCE does not block either. Slice F adds the NCE KuDE.
- Review fixes on PR E: the KuDE of an NCE answers 422 (`KudeDocumentTypeUnsupportedError`, warn level) instead of a
  500; hold tests for a missing FE, an unreadable FE payload and an invalid NCE payload; 1331 re-checked in the XML
  generator. FE byte identity is held by the unchanged `invoice-xml.golden.spec.ts` hashes.

### Slice F evidence and close (2026-10-16)

- Route: T8 to T10 inline by the writer (one PR, about 400 lines with tests).
- KuDE content (T0 uncertainty): MT v150 13.3 fixes the title "KuDE de Nota de Crédito Electrónica"; Gráfica N° 10 (the NCE
  layout) is an image the text extraction cannot read, and 13.5 calls the graphics "referential". The NT notes add nothing for
  the NCE KuDE. The layout follows the FE one, minus condition and transaction type, plus the reason (E402), the associated
  FE number and its CDC in groups of four. Confirm it against Gráfica N° 10 and the Prevalidador before homologation.
- RED: the NCE KuDE specs failed (iTiDE 5 unsupported, no title or reason); the FE PDF is pinned by a SHA-256 golden measured
  on `main` before the change and unchanged after. `KudeDocumentTypeUnsupportedError` stays for types 6, 7 and 8 (422, warn).
- Closing state: T1 to T10 done and verified in CI-equivalent runs per PR. **T0 and T11 stay open**: Prevalidador
  confirmation (FE with observations as associated, NCE without D011/E600, the timbrado per type, Gráfica N° 10) and the
  Guía de Pruebas battery (5 approved and 5 rejected NCE on both services, plus the dev-only path of ADR-0019 P4) need the
  test environment and a certificate.
