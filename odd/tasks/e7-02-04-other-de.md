# Other document types: NDE, AFE and NRE (HU-E7-02, HU-E7-03, HU-E7-04)

- Feature: `e7-02-04-other-de` · Refs: HU-E7-02, HU-E7-03, HU-E7-04 (epic E7, RF-01)
- Engram mirror: `odd/e7-02-04-other-de/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`, thresholds 85%)
- Delivery: `ask-on-risk`, `stacked-to-main`; each PR 400 changed lines or less (advisory heuristic, hard rule in CLAUDE.md).
- Template: the NCE (HU-E7-01, `odd/tasks/hu-e7-01-credit-note.md`, ADR-0019). Same endpoint, `type` discriminator, same pipeline.

## Objective

Let an integrator issue an NDE (`iTiDE` 6), an AFE (4) and an NRE (7) through `POST /v1/documents` with the same asynchronous flow as the FE
(202, numbering, signing, QR, lote, webhooks, KuDE). FE and NCE output stays byte identical.

## Normative basis (MT v150, `docs/referencia/dnit/`)

| Type | Rule | Source |
|---|---|---|
| NDE (6) | Associated FE mandatory once (2400, 2415); reason E401 1..8 mandatory (1450); no D011, E600, E010, E900 | MT group H, E5, validations 240 to 252 |
| NDE (6) | The 2417 sum rule names the credit notes only: it does not apply to a debit | MT validation 250 (H004d) |
| NDE (6) | Same currency as the FE (2438), receiver not innominado (1331), F014 = F008 - F011 - F012 - F013 (2365) | MT validations 252, 223; NT 010, NT 023 |
| AFE (4) | See the AFE slices below | MT groups D, E7, H |
| NRE (7) | See the NRE slices below | MT groups E6, E9 |

## Slices (one PR each, chained as drafts when they depend on a PR not merged yet)

### NDE

- [x] N1 domain rules and acceptance use case for an NDE (`validateCreditNoteDraft` with a kind, `createAcceptCreditNote({ kind })`)
- [ ] N2 request contract (`type: "NDE"`), XML mapping (iTiDE 6), signing store dispatch
- [ ] N3 routing in the controller, KuDE, OpenAPI, guide, e2e

### AFE

- [ ] A1 to A4 to be detailed after the NDE (domain, contract, XML and signing, KuDE and e2e)

### NRE

- [ ] R1 to R5 to be detailed after the AFE (transport data has no amounts)

## Progress

- N1 done. RED: `debit-note-draft.spec.ts` 18 failed (`validateDebitNoteDraft` missing) and `accept-debit-note.spec.ts` 2 failed (`createAcceptDebitNote` missing); GREEN after the change. Route: inline (two production files).
