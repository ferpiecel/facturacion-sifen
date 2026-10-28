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

- [ ] A1 RED/GREEN: migration 0062 + schema + db test (nomination column, subject check, immutability)
- [ ] A2 domain `nominate-rules.ts` (rules 4002/4454/4469, receiver fields by nature)
- [ ] A3 `NominationEvent` in the gateway port + `TipsEventXmlBuilder` nomination (PR 1)
- [ ] B1 use case `nominate-document` + Drizzle unit of work + signing mapping (`sign-pending-event`, signing store) (PR 2)
- [ ] B2 controller `POST :id/nominate`, error mapping, module wiring, OpenAPI regenerated, `docs/integracion/emision.md` (PR 3)
- [ ] B3 follow-ups if lines allow: NCE/NDE 2442 and `credit-note-unnamed-receiver`, `document.nominated` webhook (else open debt)

## Delivery

Forecast about 1000 authored lines: chained PRs, each at most 400, first ready for review, the rest draft with `Depende de #N`. Migration 0062 (0061 NRE, 0058 to 0060 others).

## Progress / evidence

(none yet)
