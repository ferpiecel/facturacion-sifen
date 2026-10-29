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
- [x] A1 ADR-0021, migration 0069, db tests (PR #371; blocker fixed: rollback restores guard of 0034, door requires the history row)
- [x] B1 classifier `classifyCorrection`, ports, `sumCreditNotes` excludeCdc, db table tests (PR #373, base main, Depende de #371)
- [x] B2 `createCorrectDocument` use case + spec (PR #374, Depende de #373)
- [x] B3a Drizzle `createDrizzleCorrectionUnitOfWork` + spec; `documentCorrections` exported from @sifen/db (branch feat/hu-e8-01-correct-endpoint, PR opened as #375 "Depende de #374")
- [x] B3b endpoint (PR #377, branch feat/hu-e8-01-correct-http, base main, Depende de #375)
- [x] C0 review fixes: key recheck after lock, updated_at (PR #379, branch feat/hu-e8-01-correct-fixes, Depende de #377)
- [x] (done, original text) B3b endpoint `POST /v1/documents/{id}/correct` (Idempotency-Key, documents:write): request parse by `type` (reuse parseDocumentRequest, toAcceptInvoiceInput/toSelfInvoiceDraft/toCreditNoteDraft), controller method, tokens + module wiring (CORRECT_DOCUMENT), toHttpException mapping (DocumentNotFoundError 404, DocumentNotCorrectableError 409, CorrectionTypeChangedError 422, CorrectionRequiresReissueError 422 until C), e2e with inject(), OpenAPI regen (`pnpm --filter @sifen/api openapi`). New branch from feat/hu-e8-01-correct-endpoint.
- [x] C1 reissue + 72 h window (PR #381, branch feat/hu-e8-01-reissue, Depende de #379; ADR-0021 adenda, docs/integracion/emision.md, openapi). Original text: CDC-changing path: in correctOnce, on `reissue` call the normal accept for the type with the new body (new key derived from the correction key), insert document_corrections kind=reissue with replacement_document_id, then void the old number via the E8-03 void-numbers use case (body from the rejected row: timbrado number, establishment/point codes, type, series, number); idempotent/resumable; docs/integracion/emision.md; replace CorrectionRequiresReissueError.

## Progress / evidence
RED observed for every unit (module missing). Branch chain, all PRs base main, draft: #371 (A) <- #373 <- #374 <- #375. Each PR pushed with verify OK. B-slice pushes needed `pnpm verify` ~6 min (run foreground with timeout 590). Untracked files in the worktree break verify: keep the tree clean when pushing.
Webhook events are not re-enqueued on correction (event id per doc+type already exists).

## Next step
All tasks done. If the C1 PR is over 400 lines (about 470 with docs/openapi.json generated, tests included), split docs+openapi into a follow-up. Remaining only: reviews/merge chain #371 -> #373 -> #374 -> #375 -> #377 -> #379 -> C1 PR (rebase onto main after each squash). Not done: a real e2e of a reissue through HTTP (covered by the Drizzle spec with the real void use case).

## Restack note
Migration renumbered 0065 -> 0069 at restack (done) (merge order: 0063 RUC, 0064 sync, 0065/0066 E9, 0067 E8-05, 0069 E8-01). Chain: #371 -> #373 -> #374 -> #375 -> #377 -> #379 -> #381. All three orchestrator review fixes done (key recheck, updated_at in #379; 72 h window + ADR adenda in #381).

## Review fix: one correction in flight per document (re-review of #381)
Race: a same-CDC rewrite and a reissue with another establishment could both pass; the loser of `link()` returned 409 but the replacement stayed live. Fix: table `document_correction_claims` (unique per document, migration 0069 edited on #371, renumbered to 0069 at merge, restacked chain). A reissue claims the document under its lock before issuing; the rewrite and other reissues check the claim and answer 409 `correction_in_progress` before issuing; released on pre-issue refusals; resumable with the same key. Tests: A+B interleaving in correct-document.spec.ts, claim lifecycle in the Drizzle spec and db spec. ADR-0021 adenda updated.

## Restack onto main (E9, E8-05 merged) and pre-merge fixes
- Restacked chain (real order, each on the previous): #371 `feat/hu-e8-01-correct` -> #373 `-correct-same-cdc` -> #374 `-correct-use-case` -> #375 `-correct-endpoint` -> #377 `-correct-http` -> #379 `-correct-fixes` -> #381 `feat/hu-e8-01-reissue`.
- Migration 0069 (`0069_documents_corrections`, journal idx 65, snapshot regenerated with drizzle-kit from 0068). It rewrites no CHECK list, so nothing of E9/E8-05 is at risk. `documents_guard` copy is based on 0034, still the latest version on main (0056 uses a separate trigger). db coverage test added for the table configs (#371).
- Main moved remission notes into the request contract: `POST /v1/documents/{id}/correct` now refuses `NRE` with 422 (#377).
- Fix 1 (#381): a retry whose replacement acceptance is refused by validation looks the derived key up; if the replacement already exists it is linked and the claim is kept (no release), so a later rewrite cannot leave two live documents. Test first in `correct-document.spec.ts`. `accept-invoice.ts` is unchanged: it validates before replaying a key, the caller now copes with that.
- Fix 2 (#381): `ops correction:release-claim --tenant <id> --document <id> --actor <name>` (needs `--tenant` like the other document commands, RLS-scoped). Refuses a missing claim, another tenant, and an existing replacement; audits `correction.claim_released`. Documented in `docs/operacion.md` and `docs/runbooks/correccion-atascada.md`.

## Race debt closed (branch `fix/hu-e8-01-correction-race`)
- Race: `acceptReplacement` runs outside the document lock, so a refused retry could not see a replacement the claiming attempt was still committing and released the claim. Chosen fix: `Plan.resumed` (the claim already existed at plan time); `issueAndLink` rethrows a refusal of a resumed call without releasing or looking up. Only the call that took the claim releases. Why not holding the lock across accept+link: it needs a second connection inside one unit of work and breaks the PGlite single-connection tests, far more invasive. Time-dependent validation only worsens with time, so a refused claimer implies refused resumers. Tradeoff: a claim left by a refused resumer is released by `ops correction:release-claim`. ADR-0021 adenda note appended (accepted body untouched). Test first: `correct-document.spec.ts` "never releases a claim it resumed when its retry is refused" (RED, then GREEN). A two-connection pg test was not added: the interleaving is deterministic at the use-case level.
- E2E: NRE on the correction endpoint answers 422 (`documents-correct.e2e.spec.ts`); OpenAPI 422 and description mention remission notes; `docs/api/openapi.json` regenerated.
