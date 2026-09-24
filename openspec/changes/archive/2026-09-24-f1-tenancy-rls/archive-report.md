# Archive Report: f1-tenancy-rls

**Date**: 2026-09-24  
**Change**: f1-tenancy-rls  
**Status**: Complete  
**Artifact Store**: hybrid (openspec + engram)

## Change Summary

F1 Tenancy with PostgreSQL RLS — a three-PR chain delivering tenant isolation at the database layer:
- PR #21 (7553a0b): `packages/db` scaffold with Drizzle schema, migrations, dual test harness
- PR #22 (99a7a43): RLS enforcement, tenant transaction wrapper, isolation test suite
- PR #23 (7bb9a67): Non-privileged session guard and TenantAwareProcessor
- PR #24 (d35a517): API layer wiring with nestjs-cls and CLS-backed tenant context

## Final State (Per Launch Facts)

- **CI Status**: 9/9 green, including `db-postgres` job
- **Test Coverage**: Postgres 16 real suite 30/30 pass locally; pglite all pass
- **Security Reviews**:
  - RLS escape via superuser login: **FIXED** (app_login role + re-verified CLOSED)
  - Session guard session_user gap: **FIXED**
  - Test tenant header guard: **fail-closed** (blocks on invalid header in production)
- **Accepted Debt** (HU-E1-04):
  - Global deny-by-default guard + `assertNonPrivilegedSession` call-site
  - Documented in ADR-0016 addendum
- **Other Notes**:
  - `set_config` inside function documented limit
  - Drift test ignores views/other schemas
  - `platform_admin` cannot create tenants yet (future work)

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| tenant-isolation | Created | New spec: Row-level tenant scoping via RLS |
| db-access | Created | New spec: Tenant-scoped transaction wrapper (`withTenantTransaction`) |
| architecture-boundaries | Updated (delta merged) | Framework isolation in `packages/db` |
| ci-pipeline | Updated (delta merged) | Tenant isolation suite gate (Postgres 16 testcontainers) |

## Task Completion

All 24 implementation tasks marked complete (4 phases, each phase 100% done):
- Phase 1: Foundation (6 tasks ✓)
- Phase 2: RLS enforcement (6 tasks ✓)
- Phase 3: API wiring (9 tasks ✓)
- Phase 4: Cleanup (2 tasks ✓)

Per tasks.md: 400-line budget risk was High; delivered via 3-PR chain (auto-chain strategy).

## Archive Contents

- ✅ proposal.md
- ✅ specs/ (4 domains: tenant-isolation, db-access, architecture-boundaries, ci-pipeline)
- ✅ design.md
- ✅ tasks.md (24/24 complete)
- ✅ explore.md
- ✅ archive-report.md (this file)

## Source of Truth Updated

The following main specs now reflect the final behavior:
- `openspec/specs/tenant-isolation/spec.md` (new)
- `openspec/specs/db-access/spec.md` (new)
- `openspec/specs/architecture-boundaries/spec.md` (updated with framework isolation requirements)
- `openspec/specs/ci-pipeline/spec.md` (updated with tenant isolation suite gate)

## SDD Cycle Complete

The change has been fully planned (proposal), specified (4 specs), designed, tasked (3-PR chain), implemented (4 PRs merged, CI green, security reviews closed), verified (test suite 30/30), and archived.

**Archived to**: `openspec/changes/archive/2026-09-24-f1-tenancy-rls/`

Ready for the next change.
