# Tasks: F1 Tenancy with PostgreSQL RLS

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1120 hand-written (PR1 ~340, PR2 ~390, PR3 ~390) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main (every PR targets main; dependent PRs open as drafts per repo CLAUDE.md) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main (every PR targets main; dependent PRs open as drafts per repo CLAUDE.md)
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `packages/db` scaffold, schema, migration tooling, dual harness (no RLS) | PR 1 | `pnpm --filter @sifen/db test` | pglite in-memory per file | Revert `packages/db/` dir |
| 2 | RLS migration, `withTenantTransaction`, isolation tests, CI `db-postgres` job | PR 2 | `pnpm --filter @sifen/db test:postgres` | testcontainers `postgres:16` | Revert PR2 + run `0001_rls.down.sql` |
| 3 | nestjs-cls wiring, `TenantAwareProcessor`, `apps/api` tenancy module | PR 3 | `pnpm --filter api test` | pglite + Fastify inject | Revert `apps/api` tenancy files |

## Phase 1: Foundation — packages/db scaffold (PR 1)

- [x] 1.1 Create `packages/db/{package.json,tsconfig*.json,vitest.config.ts,.dependency-cruiser.cjs,drizzle.config.ts}` (framework-free, forbid `@nestjs`, `fastify`, `bullmq`, `ioredis`, `reflect-metadata`)
- [x] 1.2 Write `packages/db/src/schema.ts` (`tenants`, `tenant_probe`, `TENANT_TABLES`)
- [x] 1.3 Write `packages/db/src/client.ts` (`createPgliteDatabase`, `createNodePostgresDatabase` → `DatabaseHandle`)
- [x] 1.4 Run `drizzle-kit generate` → `packages/db/migrations/0000_*.sql` + `meta/`
- [x] 1.5 Write `packages/db/test/support/{harness.ts,global-setup.ts}` (pglite default, `DB_TEST_DRIVER=postgres` → testcontainers)
- [x] 1.6 Verify pin `pg@8.23.0`, `@types/pg@8.23.1`, `@electric-sql/pglite@0.5.8`, `drizzle-orm@0.45.3`, `drizzle-kit@0.31.11`

## Phase 2: RLS enforcement (PR 2)

- [x] 2.1 RED: write `packages/db/test/isolation.spec.ts` — tenant A cannot read tenant B rows (spec: Tenant A reads only tenant A rows)
- [x] 2.2 RED: extend isolation spec — tenant A write to tenant B row affects zero rows (spec: Tenant A cannot write to tenant B rows)
- [x] 2.3 RED: extend isolation spec — no tenant context: SELECT returns zero rows, INSERT/UPDATE denied (spec: Deny by default)
- [x] 2.4 RED: extend isolation spec — `app.current_tenant` empty after commit and after rollback on pooled connection (spec: no leak across transactions)
- [x] 2.5 RED: extend isolation spec — `app_user` has no `BYPASSRLS`/superuser/ownership; policies apply regardless of query shape
- [x] 2.6 RED: `packages/db/test/rls-coverage.spec.ts` — every `TENANT_TABLES` entry has `relforcerowsecurity` and a policy (drift check)
- [x] 2.7 GREEN: write `packages/db/migrations/0001_rls.sql` (idempotent role creation, `ENABLE`/`FORCE RLS`, `tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid` policies `USING`+`WITH CHECK` `TO app_user`; explicit `TO platform_admin USING (true)`) and `migrations/rollback/0001_rls.down.sql`
- [x] 2.8 GREEN: write `packages/db/src/{tenant-id.ts,tenant-transaction.ts,errors.ts}` implementing `withTenantTransaction` (`BEGIN`; `select set_config('app.current_tenant', $1, true)` bound; `SET LOCAL ROLE app_user`; UUID-validate before `BEGIN`, throw `InvalidTenantIdError`)
- [x] 2.9 Export public surface via `packages/db/src/index.ts`
- [x] 2.10 Confirm all RED tests from 2.1–2.6 pass on pglite and on `DB_TEST_DRIVER=postgres`
- [x] 2.11 Add `db-postgres` job to `.github/workflows/ci.yml` running `pnpm --filter @sifen/db test:postgres`; make it a required check in the quality gate
- [x] 2.12 Write `docs/adr/0016-tenant-transaction-runner-sin-plugin-cls.md` (Spanish, short) documenting the deviation from ADR-0006 (deferred `nestjs-cls` transactional plugin, singleton `TenantTransactionRunner` instead)

## Phase 3: apps/api wiring (PR 3)

- [x] 3.1 RED: unit tests for `TestTenantHeaderGuard` — missing header → 401, invalid header → 400, throws at construction when `NODE_ENV=production` (spec: API guard requires tenant header)
- [x] 3.2 RED: `packages/db/test/tenant-aware-processor.spec.ts` — job with tenant id runs inside `withTenantTransaction`; job missing tenant id is rejected before body executes
- [x] 3.3 GREEN: `packages/db/src/tenant-aware-processor.ts` implementing `TenantAwareProcessor`
- [x] 3.4 GREEN: `apps/api/src/modules/tenancy/**` (hexagonal layout: `TestTenantHeaderGuard`, CLS resolution into `TenantTransactionRunner`)
- [x] 3.5 Wire `ClsModule.forRoot({ global: true, middleware: { mount: true } })` in `apps/api/src/app.module.ts`
- [x] 3.6 Create `apps/api/.dependency-cruiser.cjs` (forbid `drizzle-orm`, `pg`, `@electric-sql/`, `@sifen/db` outside `modules/*/infrastructure/` and `*.module.ts`) + `depcruise` script
- [x] 3.7 Integration test: request with valid header propagates tenant id via CLS into a `withTenantTransaction` call (Fastify inject + `Test.createTestingModule`)
- [x] 3.8 Update `nestjs-cls@7.0.0` dependency pin in `apps/api/package.json`; confirm coverage ≥85% holds per package
- [x] 3.9 (security review debt) `packages/db/src/session-guard.ts`: `assertNonPrivilegedSession(db)` refuses superuser/`BYPASSRLS`/tenant-table-owner sessions; tested RED→GREEN on pglite (always superuser)

## Phase 4: Cleanup

- [x] 4.1 Update `docs/adr/` cross-references — ADR-0016 addendum documents the `withTenantTransaction`/`fn` `set_config` limit and `assertNonPrivilegedSession`
- [x] 4.2 Confirm `pnpm dependency-cruiser` passes for both new local configs (spec: architecture-boundaries) — `packages/db` and `apps/api` both pass
