# HU-E5-02: idempotent `POST /v1/documents`

Story: "Como integrador, quiero que mis reintentos no dupliquen comprobantes" (RF-03, RNF-05).
Acceptance: the same `Idempotency-Key` returns the same response; a different payload with the same key returns 409.

## Decisions

- Header `Idempotency-Key` is **required** (ADR-0011: "exige Idempotency-Key"); 1..255 printable ASCII without spaces (0x21-0x7E). Missing or malformed: 400. Plan §7.2 says VARCHAR(120); the tech lead widened it to 255.
- Persistence: two nullable columns on `documents` (`idempotency_key varchar(255)`, `request_hash char(64)`) with `UNIQUE (tenant_id, idempotency_key)` (plan §7.2). Same table keeps the accept atomic: the unique index is the lock. Nullable only for rows that predate the story; a CHECK enforces both-or-neither. Environment is not part of the key (plan §7.2; a tenant has one environment at a time).
- Hash: sha-256 of the canonical JSON (sorted keys) of the validated body (`parsed.value`, defaults applied, unknown keys stripped).
- Flow: validate (422 first, a failed request does not consume the key) -> one tenant transaction: look the key up; same hash replays `{document_id, cdc}` with 202; other hash raises 409; otherwise accept. A concurrent loser hits the unique violation on insert (transaction rolls back, number not burned), the use case re-runs once in a new transaction and replays or answers 409.
- Immutability guard (`documents_guard`) now also covers the two columns.
- Migration number 0023 (0022 is reserved by PR #80, lotes).
- Out of scope / follow-up: expiry or retention of keys (docs are silent).

## Slices (each <= 400 lines)

- [x] S1 (`feat/hu-e5-02-idempotency`, ~180 lines): migration 0023 + schema + guard + rollback + db tests.
- [x] S2 (`feat/hu-e5-02-idempotency-core`, ~385 lines): canonical request hash, `AcceptInvoice` lookup/replay/409/race retry, Drizzle adapter; the controller sends a throwaway key until S3.
- [x] S3 (`feat/hu-e5-02-idempotency-api`, ~175 lines): required `Idempotency-Key` header (400), 409 mapping, e2e.

## Verification

Strict TDD (vitest). RED commit first, then GREEN. Commands: api `vitest run --coverage`, db `vitest run`, typecheck, lint, depcruise, prettier, `drizzle-kit generate` probe reports no changes.
