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

- [ ] A1 domain: `Place`, `validateSelfInvoiceDraft` (seller E4, constancia H, items and rounding reused)
- [ ] A2 acceptance (`createAcceptStandalone`, `createAcceptSelfInvoice`, type 4) and request contract (`type: "AFE"`)
- [ ] A3 XML mapping (iTiDE 4: gCamAE, gCamCond, gCamDEAsoc constancia), signing store dispatch, receiver = issuer
- [ ] A4 routing in the controller, KuDE (letter and ticket), OpenAPI, guide, e2e

### NRE (HU-E7-04)

- [ ] R1 domain: `validateRemissionDraft` (motive E501, responsible E503, transport E9, items without prices)
- [ ] R2 acceptance (type 7) and request contract (`type: "NRE"`)
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
