# HU-E5-01 — POST /v1/documents (emit an FE with one call)

## Objective

`POST /v1/documents` accepts an invoice (FE), validates it, assigns its number, computes the
44-digit CDC and persists it, answering `202` with `document_id` and `cdc`. p95 < 1.5 s
(RF-01, RF-02, RNF-04). Signing, QR, batching and transmission are out of scope (HU-E5-05/06,
E6); the document is stored as `accepted` until they exist.

## Settings

- TDD: strict (RED commit alone, then GREEN, then refactor). Runner: vitest (`@sifen/db`, `@sifen/api`).
- Delivery: PR-sized slices, each <= 400 changed lines (excluding `pnpm-lock.yaml`; generated
  drizzle snapshots are counted separately and reported). Slices are chained PRs.
- Reuse: `emission/domain` (invoice-draft, cdc, security-code), `nextDocumentNumber`,
  `nextRequestId`, `recordAudit`, `withTenantTransaction`, API-key auth.

## Slices

- [ ] **S1 — `documents` table (db).** Migration 0021 with FORCE RLS `tenant_isolation`,
  `platform_admin_all`, grants (no DELETE), immutable-identity trigger, unique CDC and unique
  number per sequence; manual rollback; schema + `TENANT_TABLES`; db tests.
  Acceptance: RLS isolates tenants; duplicate CDC/number rejected; identity columns immutable;
  RLS drift check green.
- [ ] **S2 — `AcceptInvoice` application service (api).** In one tenant transaction: validate
  the draft, `nextDocumentNumber`, `generateSecurityCode`, `buildCdc`, insert `documents` row
  (`accepted`), `recordAudit`. Returns `{ documentId, cdc }`. Acceptance: validation errors
  persist nothing and burn no number; rollback is gapless; CDC parses back to the assigned parts.
- [ ] **S3 — HTTP endpoint (api).** `POST /v1/documents` with Zod body, API-key auth, tenant
  context, `202 { document_id, cdc }`, 422 on validation errors. Acceptance: e2e happy path,
  401 without key, 422 with rule list, tenant isolation.
- [ ] **S4 — Latency and docs.** p95 < 1.5 s check on the accept path (no network I/O inside the
  numbering transaction), OpenAPI/docs update, backlog traceability.

## Open questions

- Fiscal-config resolution (timbrado, establishment, expedition point, emitter RUC) inputs for S2/S3:
  from the request or from the API key's default point? Decided in S2 design.
- Idempotency (`Idempotency-Key`) belongs to HU-E5-02; the table leaves room for it.

## Follow-ups

- Lifecycle slice: status transition guard (allowed `documents.status` moves, §8.0) and `updated_at` maintenance.

## Progress

See commits on `feat/hu-e5-01-post-documents`.
