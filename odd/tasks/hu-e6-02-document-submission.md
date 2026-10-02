# HU-E6-02 (follow-up) — From accepted documents to a sent lote

## Objective

Close the gap between `documents` (accepted/signed) and a `sent` lote: assemble ready documents into
`pending` lotes, queue them, and mark them `submitted` once SIFEN received the lote, so
`PollLoteResult` (HU-E6-03) can settle them. Sources: ADR-0007 (lote as the main path; no CDC in two
lotes in process), plan v1.1 §8.1, backlog HU-E6-01/02/03.

## Settings

- TDD: strict (RED commit alone, GREEN, refactor). Runner: vitest (`@sifen/api`, `@sifen/db`).
- Delivery: slices <= 400 changed lines. Migration number for this work: 0025.

## Findings

- `documents` has no column for the signed XML (nor `signed_at`): `invoice-signing.ts` returns
  `{ xml, signedAt }` but nothing persists it, and nothing moves `accepted -> signed`. The QR group
  (`gCamFuFD`) is added after signing, so the XML to store is the final signed+QR one.
- `documents_guard` (0024) ranks accepted < signed < queued < submitted < outcomes: `queued -> submitted`
  is allowed, regressions are not.
- `LoteBuilder.isInProcess` is synchronous, so the assembler preloads the CDCs that are in process.

## Slices

- [x] **S1 — `LoteAssembler` application service (no migration).** Port `LoteAssemblyStore`
      (`readyDocuments`, `cdcsInProcess`, atomic `createLote`), `measureMessage` injected. Groups ready
      documents by (RUC, document type), fills `LoteBuilder`, starts a new lote on `lote-full` /
      `size-exceeded`, skips `cdc-in-process` / `duplicate-cdc` / a document too big alone, and reports
      conflicts when a document stopped being ready between read and create (`createLote` returns null).
- [x] **S2 — Dispatch store marks documents `submitted`.** `record('sent')` also moves the lote's
      `queued` documents to `submitted` in the same tenant transaction (no migration; pglite test).
- [x] **S3 — Migration 0025 + Drizzle `LoteAssemblyStore`.** `documents.signed_xml text` and
      `signed_at timestamptz` (write-once once set, added to `documents_guard` keeping every existing
      rule); adapter: ready = status `signed`|`queued` with `signed_xml`, `cdcsInProcess` over
      `lote_documents` x `lotes` with status in (`pending`,`sending`,`sent`,`unknown`,`recovery`);
      `createLote` inserts the lote (tenant environment) + links and moves documents `signed -> queued`
      conditionally, returning null (rollback) if any is no longer ready.
- [ ] **S4 — Signing integration (`SignDocument`).** Loads an `accepted` document, rebuilds the draft
      from `payload`, `generateInvoiceXml` + `signInvoiceXml` (+ QR), stores `signed_xml`/`signed_at`,
      `accepted -> signed`. Needs the tenant certificate store and the QR generator.
- [ ] **S5 — Worker wiring** (`lote-build` queue: assemble, then `SendLote` per lote).

## Decisions

- Ready = `signed` (never sent) or `queued` (in a lote that is not in process any more). `queued` is set
  by the assembler, `submitted` by the dispatch store when SIFEN answered 0300.
- 0301 (lote not enqueued, lote `rejected`): documents stay `queued`, no regression and no new
  status. A `rejected` lote is terminal and not "in process" (ADR-0007: only lotes in process
  block re-inclusion), so the documents are eligible again and the next assembly puts them in a new
  lote. The failure reason lives on the lote row (`response_code`/`response_message`).
- `unknown` (no answer) and `recovery` lotes count as in process: SIFEN may hold them (plan §8.1), so
  their CDCs are never put in another lote until HU-E6-04 resolves them.
