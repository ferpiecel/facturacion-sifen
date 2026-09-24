# Tenant Isolation Specification

## Purpose

Enforce tenant isolation at the database layer via PostgreSQL Row Level Security (RLS), so no query path — application or worker — can read or write another tenant's rows, independent of application-layer discipline.

## Requirements

### Requirement: Row-level tenant scoping via RLS

Every tenant-scoped table MUST have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, with policies filtering on `current_setting('app.current_tenant', true) = tenant_id`.

#### Scenario: Tenant A reads only tenant A rows

- GIVEN tenant A's context is set and rows exist for tenant A and tenant B
- WHEN tenant A runs a SELECT with no additional filter
- THEN only tenant A rows MUST be returned

#### Scenario: Tenant A cannot write to tenant B rows

- GIVEN tenant A's context is set
- WHEN tenant A attempts an UPDATE, DELETE, or INSERT targeting a row with tenant B's `tenant_id`
- THEN the operation MUST affect zero rows or be rejected

### Requirement: Deny by default without tenant context

Queries executed without a tenant context set MUST return zero rows for SELECT and MUST be rejected for writes.

#### Scenario: No tenant context set

- GIVEN a transaction where `app.current_tenant` was never set
- WHEN a SELECT runs against a tenant-scoped table
- THEN the query MUST return zero rows

#### Scenario: Write attempted without tenant context

- GIVEN a transaction where `app.current_tenant` was never set
- WHEN an INSERT or UPDATE runs against a tenant-scoped table
- THEN the operation MUST be denied by the RLS policy

### Requirement: Tenant context does not leak across transactions

`app.current_tenant` MUST be set with `SET LOCAL` inside an explicit transaction, and MUST reset to empty after commit or rollback on a pooled connection.

#### Scenario: Context reset after commit

- GIVEN a transaction sets `app.current_tenant` for tenant A and commits
- WHEN a subsequent transaction reuses the same pooled connection without setting a tenant
- THEN `current_setting('app.current_tenant', true)` MUST be empty

### Requirement: Application role has no bypass privilege

The application database role (`app_user`) MUST NOT have `BYPASSRLS`, MUST NOT be a superuser, and MUST NOT own the tenant-scoped tables.

#### Scenario: App role attempts a query as table owner

- GIVEN `app_user` is not the owner of a tenant-scoped table and lacks `BYPASSRLS`
- WHEN `app_user` runs any query against that table
- THEN RLS policies MUST apply regardless of query shape

### Requirement: Explicit platform_admin path

Cross-tenant access MUST only be possible through the separate `platform_admin` role, which MUST NOT be used in request-serving code paths.

#### Scenario: platform_admin bypasses tenant filter deliberately

- GIVEN a session authenticates as `platform_admin`
- WHEN it queries a tenant-scoped table without setting `app.current_tenant`
- THEN rows across tenants MAY be visible, and this path MUST NOT be reachable from `apps/api` or worker request/job handling code
