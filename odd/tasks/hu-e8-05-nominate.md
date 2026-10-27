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
- [ ] B2 controller `POST /v1/documents/:id/nominate` in `IssuerEventsController`, zod request schema for the receiver (fields by nature: taxpayer ruc with DV + taxpayerType; non-taxpayer documentType 1..5 + number; name 4..255; country 3 letters; operationType B2B only for taxpayers; reason 5..500), error mapping in `issuer-event-http-errors.ts` (`NominationReasonInvalidError` 422, `NominationRefusedError` 422 with rule+sifenCode, `NominationAlreadyRequestedError` 409 sifenCode 4453), `NOMINATE_DOCUMENT` token + module wiring, e2e test like the cancel one, `pnpm --filter @sifen/api openapi`, guide `docs/integracion/emision.md`; lector role refusal if the cancel endpoint enforces one
- [ ] B3 NCE/NDE 2442 + `credit-note-unnamed-receiver` (approved nomination event = nominated receiver), `document.nominated` webhook; else record as open debt

## Handoff

Branch chain (all PRs target main): #356 `feat/hu-e8-05-nominate` (ready) <- #357 `...-rules` (draft) <- #365 `...-use-case` (draft) <- #364 `...-persist` (draft). Next: branch `feat/hu-e8-05-nominate-endpoint` from `feat/hu-e8-05-nominate-persist`, draft PR "Depende de #364". Worktree already has node_modules and builds. Verify in the pre-push hook needs a clean tree (stash untracked before pushing). No reviews posted yet (sifen-reviewer). Note: the Drizzle UoW spec was written together with its implementation (no observed RED).

## Delivery

Forecast about 1000 authored lines: chained PRs, each at most 400, first ready for review, the rest draft with `Depende de #N`. Migration 0062 (0061 NRE, 0058 to 0060 others).

## Progress / evidence

(none yet)
