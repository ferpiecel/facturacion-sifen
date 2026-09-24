# Explore: f1-tenancy-rls

Covers HU-E1-01 (RLS isolation), HU-E1-02 (tenant context via CLS), HU-E1-03 (automated isolation test).
Implements ADR-0005 (shared schema + `tenant_id` + `FORCE ROW LEVEL SECURITY`, app role without `BYPASSRLS`, separate `platform_admin` role), ADR-0006 (nestjs-cls + `SET LOCAL`, `TenantAwareProcessor` for workers), ADR-0013 (Drizzle + Postgres 16).

## Spike results

Ran against `@electric-sql/pglite@0.5.8` in `/tmp/.../scratchpad/rls-spike/test.mjs` (script preserved for reuse).

| Capability | Result |
|---|---|
| `CREATE ROLE ... LOGIN` (non-superuser) | PASS |
| `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` | PASS |
| `CREATE POLICY ... USING (tenant_id = current_setting('app.current_tenant', true))` | PASS |
| `SET ROLE app_user` + `SET LOCAL app.current_tenant` inside a transaction | PASS |
| Non-owner, non-superuser role actually filtered by tenant (tenant-a saw only tenant-a row, tenant-b only tenant-b) | PASS |
| `SET LOCAL` does not leak outside the transaction (verified `current_setting` empty post-commit) | PASS |
| `drizzle-orm/pglite` driver present and exports `drizzle()` | PASS |

Confirmed: `rolsuper=false`, `rolbypassrls=false` for the test role, and the table owner (`postgres`, the seeding superuser) is distinct from `app_user` — the owner-bypass pitfall is avoided by never running app queries as owner.

## Versions verified (`npm view`)

- `@electric-sql/pglite` 0.5.8
- `drizzle-orm` 0.45.3 (ships `drizzle-orm/pglite` and `drizzle-orm/node-postgres`)
- `drizzle-kit` 0.31.11
- `nestjs-cls` 7.0.0 — peerDeps `@nestjs/core`/`@nestjs/common` `>=10 <13`, compatible with NestJS 12 ESM
- `testcontainers` 12.1.0

## SET LOCAL vs SET, and pool leakage

`SET` persists for the life of the connection; with a pooled `pg` client a later request on the same physical connection would inherit a stale `app.current_tenant`, silently leaking cross-tenant data. `SET LOCAL` is scoped to the current transaction and is reset on commit/rollback — verified above. Consequence: every tenant-scoped query MUST run inside an explicit transaction wrapper that does `BEGIN; SET LOCAL app.current_tenant = $1; SET ROLE app_user; ...; COMMIT`, never on a bare pooled connection.

## Recommendations

**DB test strategy**: local/dev and unit-level integration tests run on `pglite` (no Docker needed, in-memory, fast). CI additionally runs the same test suite against `testcontainers` Postgres 16 (real engine, catches pglite-specific gaps) — same test files, driver swapped via env flag.

**Package layout**: `packages/db` (framework-free): Drizzle schema, `drizzle-kit`-generated migrations, hand-written SQL migration for RLS policies/roles (drizzle-kit doesn't generate `CREATE POLICY`), and a `withTenantTransaction(tenantId, fn)` helper wrapping `SET LOCAL` + `SET ROLE`. `apps/api` depends on it; `nestjs-cls` interceptor in the API module resolves tenant_id from the request and calls the helper per-request; the worker's `TenantAwareProcessor` calls it per-job.

**PR slicing (≤400 hand-written lines each)**:
1. `packages/db` scaffold: schema, migration tooling, pglite+testcontainers dual test harness (no RLS yet).
2. RLS migration: roles, `FORCE ROW LEVEL SECURITY`, policies + `withTenantTransaction` helper + isolation tests (HU-E1-01, HU-E1-03).
3. `nestjs-cls` wiring in `apps/api` (HU-E1-02) + `TenantAwareProcessor` for workers.

**Risks**: drizzle-kit generates no RLS DDL (hand-maintained SQL, must stay in sync with schema changes); owner-bypass pitfall if migrations ever run as the app role; testcontainers unavailable on dev machine (no Docker) means RLS PR reviewers must trust CI, not local runs, for the testcontainers leg.
