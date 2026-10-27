# HU-E8-01: correct and resend a rejected DE

- Feature: `hu-e8-01-correct` · Story: HU-E8-01 (RF-07, MT 6.5) · Parent plan: `odd/tasks/e8-issuer-events.md` (T8, D9)
- Branch chain: `feat/hu-e8-01-correct` (A) -> B -> C, worktree `/home/fer/github_proyects/facturacion-sifen-worktrees/e8-01`
- TDD: strict, runner Vitest (source: `openspec/config.yaml`). Migration: only `0065`.
- Route: delegated direct (sifen-writer), one writer thread.

## Objective
`POST /v1/documents/{id}/correct` takes the full corrected request body of a `rejected` DE. If the correction leaves every CDC component
unchanged (and the immutable identity: type, associated CDC), the same row is rewritten and requeued with the same CDC. Otherwise the new DE
is issued under a new number and the old number is voided through the E8-03 voiding.

## Finding
ADR-0021 did not exist when this story started (the plan says "ADR first"). It is written in slice A.

## Decision (ADR-0021, summary)
- Same CDC: guarded in-place rewrite of a `rejected` row. `documents_guard` gets one door: `rejected -> accepted` with `corrections_count + 1`,
  signed XML cleared; only `payload`, `receiver_ruc`, `total_amount` may change. Every correction is kept in the append-only
  `document_corrections` table (previous payload, previous SIFEN messages, idempotency key).
- New CDC: replacement is a normal accept (new row), linked from `document_corrections.replacement_document_id`, then the old number is voided.
- Types: FE, AFE, NCE, ND. Changing the document type is refused. Remission notes follow when their routing merges.

## Tasks
- [x] A1 ADR-0021, migration 0065 (`document_corrections`, `corrections_count`, guard door), schema, db tests (branch feat/hu-e8-01-correct, see git log)
- [ ] B1 CDC-impact classifier (pure) and `CorrectDocument` use case, same-CDC path, store, idempotency
- [ ] B2 endpoint, HTTP errors, OpenAPI regeneration
- [ ] C1 CDC-changing path: replacement accept plus void, webhook mapping, docs/integracion/emision.md

## Slices (PRs)
A: ADR + migration + db tests. B: use case + endpoint (same CDC). C: reissue + docs.

## Progress / evidence
A1 done: RED observed (missing column), GREEN 9 db tests + rls-coverage. Table tests (isolation, unique key, one reissue per doc) were trimmed for the 400-line limit: add them with the store in B1.

## Next step
Slice B: branch from feat/hu-e8-01-correct. Read accept-invoice.ts/accept-credit-note.ts/accept-standalone.ts (extract validation shared with the correction), add `sumCreditNotes` exclude-own-CDC param, pure CDC-impact classifier, CorrectDocument use case + Drizzle unit (lock row FOR UPDATE, insert document_corrections, rewrite via the guard door: status accepted, corrections_count+1, signed_xml/at NULL, attempts 0, hold/next_transmission_at/sifen_messages NULL), endpoint POST /v1/documents/{id}/correct (Idempotency-Key, documents:write), OpenAPI regen. Slice C: reissue via accept + void-numbers (body from the rejected row: timbrado number, establishment/point codes, type, series, number), docs/integracion/emision.md. Void is async; rejected docs do not block the void range.
