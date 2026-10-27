# Other document types: NDE, AFE and NRE (HU-E7-02, HU-E7-03, HU-E7-04)

- Feature: `e7-02-04-other-de` · Refs: HU-E7-02, HU-E7-03, HU-E7-04 (epic E7, RF-01)
- Engram mirror: `odd/e7-02-04-other-de/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`, thresholds 85%)
- Template: the NCE (HU-E7-01, `odd/tasks/hu-e7-01-credit-note.md`, ADR-0019). Same endpoint, `type` discriminator, same pipeline.

## Objective

Issue an NDE (`iTiDE` 6), an AFE (4) and an NRE (7) through `POST /v1/documents`, as the NCE does. FE and NCE output stays byte identical.

## Normative basis (MT v150, `docs/referencia/dnit/`)

| Type | Rule | Source |
|---|---|---|
| NDE (6) | Associated FE mandatory once (2400, 2415); reason E401 1..8 mandatory (1450); no D011, E600, E010, E900 | MT group H, E5, validations 240 to 252 |
| NDE (6) | The 2417 sum rule names the credit notes only: it does not apply to a debit | MT validation 250 (H004d) |
| NDE (6) | Same currency as the FE (2438), receiver not innominado (1331), F014 = F008 - F011 - F012 - F013 (2365) | MT validations 252, 223; NT 010, NT 023 |

## Slices (one PR each, chained as drafts when they depend on a PR not merged yet)

### NDE

- [x] N1 domain rules and acceptance use case for an NDE (`validateCreditNoteDraft` with a kind, `createAcceptCreditNote({ kind })`)
- [x] N2 request contract (`type: "NDE"`), XML mapping (iTiDE 6), signing store dispatch (the controller still answers 422 for `NDE` until N3)
- [x] N3 routing in the controller, KuDE (letter and ticket), OpenAPI, guide, e2e

### AFE (HU-E7-03)

- [x] A1 domain: `Place`, `validateSelfInvoiceDraft` (seller E4, constancia H, items and rounding reused)
- [x] A2 acceptance (`createAcceptStandalone`, `createAcceptSelfInvoice`, type 4) and request contract (`type: "AFE"`)
- [x] A3 XML mapping (iTiDE 4: gCamAE, gCamCond, gCamDEAsoc constancia), signing store dispatch, receiver = issuer
- [x] A4 split in two PRs: A4a KuDE (reader, model, letter and ticket) on `feat/hu-e7-03-afe-kude`; A4b routing (`ACCEPT_SELF_INVOICE`, controller, OpenAPI, guide, e2e) on `feat/hu-e7-03-afe-routing-kude`

### NRE (HU-E7-04)

- [x] R1 domain: `validateRemissionDraft` (motive E501, responsible E503, transport E9, items without prices) 8d6b71c
- [x] R2 acceptance (type 7) and request contract (`type: "NRE"`) 8d6b71c (acceptance), request commit on branch tip
- [ ] R3 XML mapping (iTiDE 7: gCamNRE, gTransp, no gOpeCom/gTotSub/gValorItem/gCamIVA) and signing store dispatch
- [ ] R4 routing, KuDE (letter and ticket), OpenAPI, guide, e2e

### Normative basis for AFE and NRE (MT v150)

| Type | Rule | Source |
|---|---|---|
| AFE (4) | gCamAE mandatory (2550); seller nature 1/2, id type 1..4, place of the transaction | E300-E322 |
| AFE (4) | Receiver = issuer (D206 = D101, 1317), nature contribuyente (1315), operation B2C (1316), cash only (1503) | D3, E7 |
| AFE (4) | One associated document, a constancia (H002 = 3, 2416); type 1 no contribuyente, 2 microproductores; number 11 digits and control 8 characters (H016, H017) | H, 2415 |
| AFE (4) | No gCamIVA (1901), no gTransp (2101), no F002-F005, F015-F020, F023, F025, F026 | E730, E900, F001 |
| NRE (7) | gCamNRE mandatory (2600); motive 1..14 or 99 (with text), responsible 1..5, dKmR, dFecEm optional | E500-E506 |
| NRE (7) | Motive 7 requires receiver RUC = issuer RUC (2606) | E501 |
| NRE (7) | gTransp mandatory (2100): type, modality, freight responsible, start and end dates, departure, delivery, vehicle, carrier | E900-E997, 2102-2113, 2150 |
| NRE (7) | No gOpeCom (1201), no gTotSub, no gValorItem (1851), no gCamIVA (1901); receiver address mandatory (1318) | D010, F001, E720, E730, D213 |

Library constraints (xmlgen 1.0.283, `facturacionelectronicapy-xmlgen`): it needs district codes, the constancia number and control for both types, and `dKmR` for the NRE; the contract requires them even where the MT says optional.

## Progress

- N1 done. RED: `debit-note-draft.spec.ts` 18 failed (`validateDebitNoteDraft` missing) and `accept-debit-note.spec.ts` 2 failed (`createAcceptDebitNote` missing); GREEN after the change. Route: inline (two production files).

- N2 done (branch `feat/hu-e7-02-nde-contract-xml`, chained on #293). RED: request spec 3 failed (`parseCreateDebitNote` missing), signing spec 2 failed (`DocumentTypeNotSignableError` for type 6); the XML spec could not import before the packages were built, GREEN after. Route: inline.
- N2 commits: 726662a (feature), d0af865 (lint fix); rebased on main after #293 merged. `pnpm verify` OK.
- N3 done (branch `feat/hu-e7-02-nde-routing-kude`, on main after #295). RED: letter/ticket KuDE specs and the three NDE e2e tests failed before the change. Also folded the #293/#295 review nits: `associated-document-unreadable` message now says credit or debit note; `readDocument` throws explicitly for any type other than 1, 5, 6; the NDE `dDesTiDE` text is asserted. `pnpm verify` coverage ran with `--maxWorkers=2` (SIGKILL under memory pressure otherwise): 2584 passed. Route: inline.
- N3 commits: 9ea40e7 (routing, KuDE letter, OpenAPI, guide), 060be24 (ticket KuDE).

### AFE and NRE progress (handoff)

- A1 a21529b, PR #322 (main). A2 710924f, PR #326 (draft, depends on #322). A3 db890c5 and d643596 on `feat/hu-e7-03-afe-xml-signing` (pushed after a verify fix; open the draft PR "Depende de #326").
- Route: inline for all (the orchestrator cut the writer; context was the limit). Experiments confirmed xmlgen 1.0.283 builds AFE and NRE XML that pass `siRecepDE` (see `invoice-xml.self-invoice.spec.ts`).
- Reusable seams: `createAcceptStandalone` (NRE only needs `{ documentType: 7, validate, total: () => '0', receiverRuc }`), `Place` and `validatePlace` (NRE departure/delivery), `itemsSchema.element.omit({...})` for the NRE items, `patchGeoGroup`/`geoExpectations` in `invoice-xml.ts` (NRE: groups `gCamSal`, `gCamEnt` with suffixes `Sal`, `Ent`), `readSelfInvoicePayload` in the signing store as the pattern for the NRE.
- NEXT (A4, worktree `de-afe-c`, branch `feat/hu-e7-03-afe-routing-kude`, no code yet): `parseDocumentRequest` accepts `AFE`; controller routes to a new `ACCEPT_SELF_INVOICE` token wired in `emission.module.ts`; KuDE: `KudeInvoice.selfInvoice` (seller, place, constancia), title "KuDE de Autofactura Electrónica" (MT 13.3), `readKudeInvoice` accepts iTiDE 4 (reads `gCamAE`, `gCamDEAsoc` constancia, shows `dNomRec`), letter and ticket renderers; OpenAPI `docs/api/openapi.json` (regenerate with `pnpm --filter @sifen/api openapi`), `docs/integracion/emision.md`, e2e in `apps/api/test/documents.e2e.spec.ts` and `documents-kude.e2e.spec.ts`. Template: commit d024976 (NDE routing).
- NRE: R1 to R4 not started. MT facts are in the table above; items carry code, description, unitCode, quantity only (no gValorItem, E715 optional); no totals; `dKmR` mandatory by NT 009 (xmlgen validation); xmlgen supports one delivery, one vehicle, one carrier.
- Pending validations for the PRs: E306 alphanumeric vs xmlgen digits-only; E312/E319 district required by xmlgen; E304/2562 needs a Marangatu lookup; E715 mandatory (1805) vs optional (field table).
- Do not edit a worktree while its `pnpm verify` push runs (untracked files break `format:check`).

### Handoff 2 (writer stopped at the context limit)

- Review fixes done and pushed: #322 bd5ff81 (constancia number must be 11 digits not starting with 0; control `[0-9A-Za-z-]{8}`), #326 (idNumber `^[0-9A-Za-z-]{1,20}$`; PR body now lists E306/H016/H017 under pending validations), #332 (xmlgen console output muted in `packages/sifen-tips/src/de-xml-builder.ts`, tested). Chain restacked: #322 -> #326 -> #332 -> A4a -> A4b.
- A4a branch `feat/hu-e7-03-afe-kude` (worktree `de-afe-c`) and A4b `feat/hu-e7-03-afe-routing-kude` (rebased on A4a): committed locally; the pre-push of A4a failed once on a lint error (fixed in a later commit). Check `git ls-remote origin 'feat/hu-e7-03-afe-*'`; push A4a, then A4b (draft PRs, `Depende de #<prev>`, Spanish body per the template, A4a base chained on #332). A4a is about 237 changed lines, A4b about 358.
- Test helper added: `selfInvoice` transform in `apps/api/test/support/signed-invoice.ts` (real xmlgen AFE XML). The e2e `type` unknown test now uses `XYZ`; the KuDE no-layout tests now use iTiDE 7 (NRE): when NRE gets its KuDE (R4) change them to a type that remains unsupported or drop them.
- NRE not started. Worktree `de-nre-a` exists (branch `feat/hu-e7-04-nre-domain` from the A4b tip, installed and built, no changes). Plan R1 to R4 above; seams: `createAcceptStandalone` with `documentType: 7`, `total: () => '0'`; `Place`/`validatePlace`; `itemsSchema.element.omit({...})`; `patchGeoGroup` with `gCamSal`/`gCamEnt`; E715 contradictory: pick the stricter reading (item price absent) and list it under "Validaciones pendientes". For the KuDE NRE use `selfInvoice` helper as a model to build a real xmlgen type 7 fixture.

### NRE handoff 3 (R1 and R2 done, branch `feat/hu-e7-04-nre-domain`)

- Done: `domain/remission-draft.ts` (tables, `validateRemissionDraft(draft, config, issuerRuc?)`, motive 7 rule 2606 only when `issuerRuc` is given), `createAcceptRemission` in `accept-standalone.ts` (new optional `StandaloneKind.validateWithIssuer`, runs inside the transaction before numbering), `infrastructure/http/remission.request.ts` (`parseCreateRemission`, `toRemissionDraft`, `placeFields` exported from `self-invoice.request.ts`), dispatcher `NRE` in `credit-note.request.ts`. Also fixed a failing AFE dispatcher test inherited from the AFE tip (`items: []` is not a schema error; it now removes `seller`).
- NEXT R3 (new branch from this one, draft PR "Depende de #<this PR>"): add `remission?: { motive, responsible, km, invoiceDate?, transport }` to `InvoiceXmlContext` and `documentTypeOf` -> 7 in `invoice-xml.ts`. Store builds the xmlgen draft as receiver named, B2B, items `{ quantity, unitPrice: 0, vatRate: 0 }`, `location.departmentCode = receiver.departmentCode`. In `mapInvoiceToXmlInput` for type 7 emit `remision: { motivo, remisionesResponsables: responsible, kms: km, fechaFactura }`, `descripcion` (xmlgen REQUIRES it for type 7, dInfoFisc: use the motive text), `detalleTransporte` (`tipo`, `modalidad`, `tipoResponsable`, `inicioEstimadoTranslado`, `finEstimadoTranslado`, `salida`/`entrega` {direccion, numeroCasa, departamento, distrito, ciudad}, `vehiculo` {tipo, marca, documentoTipo, documentoNumero}, `transportista` {contribuyente, nombre, ruc | documentoTipo+documentoNumero, direccion, chofer {documentoNumero, nombre, direccion}}), and no `condicion`/`factura`. xmlgen emits no gValorItem/gTotSub/gCamIVA for type 7 by itself; verify against the XSD (`generateInvoiceXml`). Geo text: `patchGeoGroup` groups `gCamSal`/`gCamEnt` with suffixes `Sal`/`Ent` (extend `geoExpectations` suffix union). Signing store: `readRemissionPayload` like `readSelfInvoicePayload`, type 7 added to the signable list. Unresolved: xmlgen has fixed text for motive 99 ("Otro"), no custom text.
- NEXT R4: controller route `NRE` (new `ACCEPT_REMISSION` token in `emission.tokens.ts` and `emission.module.ts`, `createAcceptRemission`), `KudeInvoice.remission` and `readKudeInvoice` for iTiDE 7 (title "KuDE de Nota de Remisión Electrónica"; no prices/totals), letter and ticket renderers; the two KuDE "no layout" tests that use iTiDE 7 must switch to another unsupported type; OpenAPI (`pnpm --filter @sifen/api openapi`), `docs/integracion/emision.md`, e2e in `apps/api/test/documents.e2e.spec.ts` and `documents-kude.e2e.spec.ts`.
- Validaciones pendientes for the PR bodies: E715 read strictly (item price refused, 1851); E306/E312/E319 as for the AFE; motive 99 free text; carrier agent (E996-E997), several vehicles/deliveries, nationality not supported by the contract.
- Rebase after the AFE chain lands: `git rebase --onto origin/main feat/hu-e7-03-afe-routing-kude`.

- NRE R3 done (branch `feat/hu-e7-04-nre-xml`): `InvoiceXmlContext.remission`, type 7 mapping (xmlgen key is `remision.tipoResponsable`, not `remisionesResponsables`), `patchRemissionGeo` (gCamSal/gCamEnt), `readRemissionPayload` in the signing store, type 7 signable. The store test that held iTiDE 7 now uses 8. NEXT R4 as listed in handoff 3.
- NRE R4a done (branch `feat/hu-e7-04-nre-kude`): `readKudeInvoice` type 7 (no gOpeCom/gCamCond/gTotSub/prices), `KudeInvoice.remission`, letter and ticket renderers (`remissionRows` in `kude-pdf-common.ts`), test helper `remissionNote`. KuDE no-layout tests now use iTiDE 8. NEXT R4b (branch `feat/hu-e7-04-nre-routing`): controller route NRE (`ACCEPT_REMISSION` token + module), OpenAPI regen, `docs/integracion/emision.md`, e2e (documents + kude).
- NRE R4b done (branch `feat/hu-e7-04-nre-routing`): route, OpenAPI, docs, e2e. Chain rebased on main after HU-E3-03 (#346): `assertCertificateUsable` already runs in `createAcceptStandalone` before `nextNumber` for the NRE too (test in `accept-remission.spec.ts`). Review fix: an NRE receiver may omit `ruc` for motives 3 and 5 (export/import) with `idType` 1..4, `idNumber`, `countryCode`; rule `remission-receiver-document`; XML maps `contribuyente: false` with operation B2C (B2F is not built yet, MVP; listed under Validaciones pendientes). KuDE already prints the document number when dRucRec is absent.
