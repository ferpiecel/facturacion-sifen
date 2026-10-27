# HU-E8-01: correct and resend a rejected DE

- Feature: `hu-e8-01-correct` · Story: HU-E8-01 (RF-07, MT 6.5) · Parent plan: `odd/tasks/e8-issuer-events.md` (T8, D9)
- Branch chain: `feat/hu-e8-01-correct` (A) -> B -> C, worktree `/home/fer/github_proyects/facturacion-sifen-worktrees/e8-01`
- TDD: strict, runner Vitest (source: `openspec/config.yaml`). Migration: only `0069`.
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
- [x] A1 ADR-0021, migration 0065, db tests (PR #371; blocker fixed: rollback restores guard of 0034, door requires the history row)
- [x] B1 classifier `classifyCorrection`, ports, `sumCreditNotes` excludeCdc, db table tests (PR #373, base main, Depende de #371)
- [x] B2 `createCorrectDocument` use case + spec (PR #374, Depende de #373)
- [x] B3a Drizzle `createDrizzleCorrectionUnitOfWork` + spec; `documentCorrections` exported from @sifen/db (branch feat/hu-e8-01-correct-endpoint, PR opened as #375 "Depende de #374")
- [ ] B3b endpoint `POST /v1/documents/{id}/correct` (Idempotency-Key, documents:write): request parse by `type` (reuse parseDocumentRequest, toAcceptInvoiceInput/toSelfInvoiceDraft/toCreditNoteDraft), controller method, tokens + module wiring (CORRECT_DOCUMENT), toHttpException mapping (DocumentNotFoundError 404, DocumentNotCorrectableError 409, CorrectionTypeChangedError 422, CorrectionRequiresReissueError 422 until C), e2e with inject(), OpenAPI regen (`pnpm --filter @sifen/api openapi`). New branch from feat/hu-e8-01-correct-endpoint.
- [ ] C1 CDC-changing path: in correctOnce, on `reissue` call the normal accept for the type with the new body (new key derived from the correction key), insert document_corrections kind=reissue with replacement_document_id, then void the old number via the E8-03 void-numbers use case (body from the rejected row: timbrado number, establishment/point codes, type, series, number); idempotent/resumable; docs/integracion/emision.md; replace CorrectionRequiresReissueError.

## Progress / evidence
RED observed for every unit (module missing). Branch chain, all PRs base main, draft: #371 (A) <- #373 <- #374 <- #375. Each PR pushed with verify OK. B-slice pushes needed `pnpm verify` ~6 min (run foreground with timeout 590). Untracked files in the worktree break verify: keep the tree clean when pushing.
Webhook events are not re-enqueued on correction (event id per doc+type already exists).

## Next step
B3b then C1 as above, each its own PR <=400 lines.
