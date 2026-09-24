# DB Access Specification

## Purpose

Provide a framework-free `packages/db` with Drizzle schema, migrations, a tenant-scoped transaction helper, and dual test harness, and propagate tenant context from HTTP requests and worker jobs into that helper.

## Requirements

### Requirement: Tenant-scoped transaction wrapper

`withTenantTransaction(tenantId, fn)` MUST run `fn` inside a database transaction that issues `BEGIN`, `SET LOCAL app.current_tenant`, and `SET LOCAL ROLE app_user` before executing `fn`, and MUST commit or roll back atomically.

#### Scenario: Successful tenant-scoped operation

- GIVEN a valid `tenantId` and a callback that performs a query
- WHEN `withTenantTransaction(tenantId, fn)` is invoked
- THEN the transaction MUST set the tenant context before `fn` runs
- AND MUST commit if `fn` resolves successfully

#### Scenario: Callback throws

- GIVEN a callback that throws an error
- WHEN `withTenantTransaction(tenantId, fn)` is invoked
- THEN the transaction MUST roll back
- AND the tenant context MUST NOT persist on the connection afterward

### Requirement: Dual test harness

The test suite MUST run against `pglite` by default and MUST run against a `testcontainers` Postgres 16 instance in CI, using the same test files with the driver selected by an environment flag.

#### Scenario: Local run uses pglite

- GIVEN no CI environment flag is set
- WHEN the DB test suite runs
- THEN it MUST execute against `pglite` without requiring Docker

#### Scenario: CI run uses Postgres 16 via testcontainers

- GIVEN the CI environment flag is set
- WHEN the DB test suite runs
- THEN it MUST execute the same test files against a `testcontainers` Postgres 16 instance

### Requirement: API guard requires tenant header

The `apps/api` request pipeline MUST reject any request lacking a tenant-identifying header before it reaches tenant-scoped persistence code.

#### Scenario: Request without tenant header

- GIVEN an incoming HTTP request has no tenant header
- WHEN the request reaches the tenant guard
- THEN the guard MUST reject the request before any `withTenantTransaction` call

#### Scenario: Request with tenant header

- GIVEN an incoming HTTP request carries a valid tenant header
- WHEN the request reaches the tenant guard
- THEN the guard MUST propagate the tenant id via CLS into `withTenantTransaction` for downstream persistence calls

### Requirement: Worker processor runs jobs in tenant transaction

`TenantAwareProcessor` MUST resolve the job's tenant id and execute the job body inside `withTenantTransaction` for that tenant.

#### Scenario: Job carries a tenant id

- GIVEN a queued job includes a tenant id in its payload
- WHEN `TenantAwareProcessor` processes the job
- THEN the job body MUST run inside `withTenantTransaction(tenantId, ...)`

#### Scenario: Job missing a tenant id

- GIVEN a queued job has no tenant id in its payload
- WHEN `TenantAwareProcessor` processes the job
- THEN the processor MUST reject the job before executing its body
