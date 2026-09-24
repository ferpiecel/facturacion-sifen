# Delta for CI Pipeline

## ADDED Requirements

### Requirement: Tenant isolation suite gate

CI MUST run the `packages/db` isolation test suite against a `testcontainers` Postgres 16 instance, and MUST fail the workflow if any isolation test fails.

#### Scenario: Isolation suite passes on Postgres 16

- GIVEN a commit where every tenant-isolation test passes against `testcontainers` Postgres 16
- WHEN CI runs the DB suite
- THEN the job MUST report success
- AND the overall workflow run MUST be green

#### Scenario: An isolation failure fails CI

- GIVEN a commit breaks tenant isolation (e.g. a cross-tenant read succeeds)
- WHEN CI runs the DB suite against Postgres 16
- THEN the job MUST exit non-zero
- AND the overall workflow run MUST be marked failed
