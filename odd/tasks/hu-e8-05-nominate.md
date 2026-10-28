# HU-E8-05: nominate an FE issued to an unnamed receiver

- Feature: `hu-e8-05-nominate` · Refs: HU-E8-05 (RF-27; NT 014, 015, 027) · Epic plan: `odd/tasks/e8-issuer-events.md` (slices E8-05 A and B)
- Branch: `feat/hu-e8-05-nominate` (worktree `facturacion-sifen-worktrees/e8-05`) · TDD: on (strict_tdd, `openspec/config.yaml`), runner Vitest
- Route: delegated direct (sifen-writer); inline edits per task.

## Objective

`POST /v1/documents/{id}/nominate` names the receiver of an approved FE issued to "Sin Nombre" (D208 = 5), as an issuer event
(`kind = nomination`) through the existing `issuer_events` pipeline (ADR-0020): pending, signed, batched (at most 15), settled/recovered.

## Rules (MT 11.6 / NT 014, 015, 027)

- 4453: one nomination per CDC (partial unique index `issuer_events_open_idx`; a rejected one may be retried).
- 4454 / 4468: the document must be an FE (type 1) of the issuer (tenant scoped by RLS: a foreign id is 404).
- 4469: the FE receiver must be unnamed (`payload.receiver.kind = 'unnamed'`).
- 4002: the FE must be approved (`approved`, `approved_with_observations`).
- Fields by receiver nature: taxpayer (`iNatRec` 1: RUC with DV, taxpayer type 1|2) or not (`iNatRec` 2: document type 1 to 5, number). Operation type B2B (taxpayers only), B2C, B2F; country (3 letters); name 4 to 255; optional address block, phone, mobile, email, customer code; reason 5 to 500.

## Design

- No new table: migration 0062 adds `issuer_events.nomination jsonb` (the receiver as requested), CHECK `(kind = 'nomination') = (nomination IS NOT NULL)`, immutable after insert. The approved nomination event is the stored nominated receiver.
- Additive only (HU-E9 extends the same pipeline): new files, one new column, new union members.

## Tasks

- [x] A1 migration 0062 + schema + db spec (PR #356, `70ed097`)
- [x] A2 domain `nominate-rules.ts` (PR #357)
- [x] A3 `NominationEvent` in the gateway + `TipsEventXmlBuilder` nomination + XSD e2e (PR #357)
- [x] B1a use case `nominate-document` + port (PR #365, branch `feat/hu-e8-05-nominate-use-case`)
- [x] B1b Drizzle `drizzle-nomination-unit-of-work` + `SignPendingEvent`/signing store load the nomination (PR #364, branch `feat/hu-e8-05-nominate-persist`, stacked on use-case)
- [x] B2 request schema + error mapping (PR #367, `85a00f2`, branch `...-request`); controller, module wiring, e2e, OpenAPI, guide `docs/integracion/eventos.md` (PR #368, `8814794`, branch `...-endpoint`)
- [x] B3a `document.nominated` webhook (migration 0068 widens the CHECKs; renumber at merge), branch `feat/hu-e8-05-nominate-effects` on #368
- [x] B3b acceptance: NCE/NDE over an unnamed FE with an APPROVED nomination passes 1331 (`credit-note-unnamed-receiver`; MT v150 has no 2442 text in docs, plan v1.1 §8.6 says H004i/2442 = note receiver must equal the nominated one); `findAssociatedInvoice` swaps receiver/operationType/location/receiverRuc for the nominated ones (`domain/nominated-receiver.ts`)
- [ ] B3c (NEXT) signing/XML: without it the NCE is accepted but cannot be signed (it would hit `invoice-xml.ts` 1331 guard / `requireNamedReceiver`). Steps: (1) RED in `drizzle-signing-store.spec.ts` (draft patch was at scratchpad `signing-spec.patch`; the NCE row must copy the FE's establishmentId/expeditionPointId/timbradoId, the last attempt failed with `SigningDataIncompleteError: establishment, expeditionPoint` because `...fe` spread lost the FK columns: set them explicitly and give the payload `establishment: '001', expeditionPoint: '001'`); (2) `readNotePayload` takes the FE's approved nomination (query `issuer_events` by FE id, kind nomination, status approved) and, when the FE receiver is unnamed, returns draft = `nominatedFacts(...)` + `receiver: { nominated }`; (3) `XmlReceiver` union in `invoice-xml.ts`: `{ nominated: NominationEventReceiver }` -> `nominatedReceiverInput` (xmlgen `cliente`: taxpayer -> contribuyente true, ruc, tipoContribuyente; non-taxpayer -> documentoTipo/Numero; razonSocial, nombreFantasia, pais, address block, telefono, celular, email, codigo), relax the 1331 guard at `invoice-xml.ts` ~597 for it, XSD spec; (4) docs `docs/integracion/emision.md` (1331 row: accepted once the nomination is approved) + `eventos.md` + openapi description + `pnpm --filter @sifen/api openapi`; (5) PR "Depende de #368".
## Handoff

Branch chain (all PRs target main): #356 `feat/hu-e8-05-nominate` (ready) <- #357 `...-rules` (draft) <- #365 `...-use-case` (draft) <- #364 `...-persist` (draft). Next: branch `feat/hu-e8-05-nominate-endpoint` from `feat/hu-e8-05-nominate-persist`, draft PR "Depende de #364". Worktree already has node_modules and builds. Verify in the pre-push hook needs a clean tree (stash untracked before pushing). No reviews posted yet (sifen-reviewer). Note: the Drizzle UoW spec was written together with its implementation (no observed RED).

## Delivery

Forecast about 1000 authored lines: chained PRs, each at most 400, first ready for review, the rest draft with `Depende de #N`. Migration 0062 (0061 NRE, 0058 to 0060 others).

## Progress / evidence

PRs: #356 <- #357 <- #365 <- #364 <- #367 <- #368 (all target main; PR bodies say PR n/6). Do not rebase onto main until HU-E9 merges; the orchestrator restacks. Pre-push verify green on #367 and #368. Next: B3 (webhook `document.nominated`, NCE/NDE over a nominated FE 2442) on a branch from `feat/hu-e8-05-nominate-endpoint`, draft PR "Depende de #368".


B3 progress: branch `feat/hu-e8-05-nominate-effects` holds B3a and B3b (PR to open as draft, Depende de #368). B3c remains.
