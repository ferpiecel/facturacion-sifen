# Audit every platform_admin use

- Feature: `platform-audit` · Debt: Engram `debt/platform-admin-read-audit`
- Engram mirror: `odd/platform-audit/tasks`
- TDD: strict (source: openspec/config.yaml) · runner: Vitest (`pnpm --filter @sifen/db exec vitest run test/platform-audit.spec.ts`, `pnpm --filter @sifen/api exec vitest run src/cli src/worker`)
- Delivery: `auto-chain`, 2 PRs

## Objective

AGENTS.md: "platform_admin es solo para jobs cross-tenant auditados". Today cross-tenant reads
(ops `document:deadline`/`certificate:expiring` without `--tenant`, `usage:show`, plan/subscription commands,
the worker's tenant directory and platform gauges) leave no audit entry. `audit_log` is per tenant and cannot hold them.

## Design (smallest correct)

- New table `platform_audit_log` (no `tenant_id`): id, occurred_at (forced to now()), actor, purpose, scope (jsonb array
  of tables/jobs), row_count (nullable), seq/prev_hash/hash (one global SHA-256 chain, same recipe as `audit_log`).
- Append-only trigger (no role exempt, no `audit_maintenance`), no TRUNCATE. Only `platform_admin` has SELECT+INSERT
  (RLS enabled+forced, policy for platform_admin only); `app_user` has no grant at all.
- `withPlatformAdminTransaction(db, { actor, purpose, scope, rowCount?, throttleSeconds? }, fn)` in `@sifen/db` is the only way
  to `SET LOCAL ROLE platform_admin`; it writes the record in the same transaction after `fn`, so a failed audit write rolls back
  the whole operation. CLI `asPlatformAdmin` becomes a thin wrapper that requires actor + purpose.
- Noise policy: system jobs pass `throttleSeconds`; the record is skipped when the same actor+purpose already has an entry
  inside the window (checked in SQL, so it holds across worker restarts and replicas). Gauges (every 60 s) and tenant
  directory (every cycle) are `system:*` actors with a 15 min window: the entry means "used at least once in the window".
  CLI commands are never throttled (one entry per invocation).
- Actor of the CLI: `ops-cli:<OS user>`.
- ADR-0023 records the decision.

## Tasks

- [x] T1 Migration + schema + `withPlatformAdminTransaction` + db tests + ADR (PR 1, commits d716ebff rebased as the first #404 commit, 11d52e4a ADR notes)
- [x] T2 Callers: CLI (`asPlatformAdmin`, 7 sites), worker tenant directory, platform gauges, docs (PR 2)
- [x] T3 `ruc:unblock` (added by #401) moved from a raw `SET LOCAL ROLE platform_admin` to `asPlatformAdmin`; test in `apps/api/src/cli/platform-audit.spec.ts` (RED on the pre-conversion code: no audit row; GREEN after)

## Evidence

- `pnpm --filter @sifen/db exec vitest run test/platform-audit.spec.ts`: 9 pass.
- `pnpm --filter @sifen/api exec vitest run src/cli src/worker/platform-gauges.spec.ts src/worker/drizzle-tenant-directory.spec.ts`: 286 pass (before T3 test).
- `drizzle-kit generate` on the #404 branch: "No schema changes, nothing to migrate", so `meta/0072_snapshot.json` matches the schema (journal idx 68 after 0071).
