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
- [ ] A1 ADR-0021, migration 0065 (`document_corrections`, `corrections_count`, guard door), schema, db tests
- [ ] B1 CDC-impact classifier (pure) and `CorrectDocument` use case, same-CDC path, store, idempotency
- [ ] B2 endpoint, HTTP errors, OpenAPI regeneration
- [ ] C1 CDC-changing path: replacement accept plus void, webhook mapping, docs/integracion/emision.md

## Slices (PRs)
A: ADR + migration + db tests. B: use case + endpoint (same CDC). C: reissue + docs.

## Progress / evidence
(none yet)

## Next step
Start A1: write the failing db test for the guard door.
