# Proposal: F1 Tenancy with PostgreSQL RLS

## Intent

No persistence exists yet. Before any domain table lands, tenant isolation must be enforced by the database, not by application discipline (ADR-0005, ADR-0006, ADR-0013). Covers HU-E1-01, HU-E1-02, HU-E1-03.

## Scope

### In Scope
- New framework-free `packages/db`: Drizzle schema (`tenants` + one tenant-scoped sample table), drizzle-kit migrations.
- Hand-written SQL migration: roles `app_user` (no `BYPASSRLS`) and `platform_admin`; `ENABLE` + `FORCE ROW LEVEL SECURITY`; policies on `current_setting('app.current_tenant', true)`.
- `withTenantTransaction(tenantId, fn)`: `BEGIN` + `SET LOCAL app.current_tenant` + `SET LOCAL ROLE app_user`.
- Dual test harness: pglite always; testcontainers `postgres:16` in CI only (env flag).
- Mandatory CI isolation suite (HU-E1-03).
- `apps/api` nestjs-cls wiring; tenant id from a header via a **test-only guard, temporary until API keys (HU-E1-04)**.
- `TenantAwareProcessor` base for future workers.

### Out of Scope
- API keys (HU-E1-04), real domain tables, portal auth, `platform_admin` operational tooling.

## Capabilities

### New Capabilities
- `tenant-isolation`: RLS roles/policies, deny-by-default without tenant, isolation test suite.
- `db-access`: `packages/db` schema, migrations, `withTenantTransaction`, dual harness, CLS/processor tenant propagation.

### Modified Capabilities
- `architecture-boundaries`: `packages/db` must not import `@nestjs/*`, `fastify`, `bullmq`.
- `ci-pipeline`: CI runs the DB suite against testcontainers Postgres 16; isolation suite failure fails CI.

## Approach

Follow explore.md. Three PRs (≤400 hand-written lines each):
1. `packages/db` scaffold + schema + migration tooling + dual harness (no RLS).
2. RLS migration + `withTenantTransaction` + isolation tests.
3. nestjs-cls wiring in `apps/api` + `TenantAwareProcessor`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/db/` | New | Schema, migrations, helper, tests |
| `apps/api/src/` | Modified | CLS module, test-only tenant guard |
| `.dependency-cruiser.cjs` | Modified | `packages/db` rule |
| `.github/workflows/` | Modified | testcontainers leg |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Pool context leak (stale tenant) | Med | Only `SET LOCAL` inside transaction; test asserts reset after commit |
| Missing tenant exposes rows | Med | `current_setting(..., true)` NULL matches nothing: deny by default; tested |
| Owner bypass (queries as owner) | Low | App runs as `app_user`; FORCE RLS; migrations as owner only |
| `platform_admin` misuse | Low | Not wired into request paths; any future use audited |
| RLS SQL drifts from schema | Med | Isolation suite per tenant table, mandatory in CI |
| pglite differs from Postgres | Low | Same suite on Postgres 16 in CI |
| Header guard reaches production | Med | Test-only, documented temporary until HU-E1-04 |

## Rollback Plan

Each PR is squash-merged and revertable independently. No production data exists; revert PR 3, then 2, then 1. Dropping roles/policies via a down SQL script if a DB was migrated.

## Dependencies

- `drizzle-orm` 0.45.3, `drizzle-kit` 0.31.11, `@electric-sql/pglite` 0.5.8, `nestjs-cls` 7.0.0, `testcontainers` 12.1.0.
- Docker on CI runners.

## Success Criteria

- [ ] Tenant A cannot read or write tenant B rows (pglite and Postgres 16).
- [ ] Query without tenant context returns zero rows / rejects writes.
- [ ] `app.current_tenant` empty after commit/rollback.
- [ ] Isolation suite runs and gates CI; coverage gate ≥85% holds.
