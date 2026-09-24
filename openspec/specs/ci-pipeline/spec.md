# CI Pipeline Specification

## Purpose

Provide a GitHub Actions workflow that enforces quality gates (lint, typecheck, architecture boundaries, tests) on every push and pull request, using the same pinned Node/pnpm toolchain as local development.

## Requirements

### Requirement: CI workflow triggers and toolchain setup

The repository MUST include `.github/workflows/ci.yml` that triggers on `push` and `pull_request`, and MUST set up Node 22 with pnpm via corepack before installing dependencies.

#### Scenario: CI runs on a pull request

- GIVEN a pull request is opened against `main`
- WHEN the CI workflow triggers
- THEN it MUST check out the code, set up Node 22, enable corepack/pnpm, and run `pnpm install --frozen-lockfile`

### Requirement: Quality gate jobs

CI MUST run lint, typecheck, dependency-cruiser (architecture boundaries), and the test suite, and MUST fail the workflow if any of them fails.

#### Scenario: All quality gates pass

- GIVEN a commit that satisfies lint, typecheck, dependency-cruiser rules, and all tests
- WHEN CI runs
- THEN every job (lint, typecheck, architecture-boundaries, test) MUST report success
- AND the overall workflow run MUST be green

#### Scenario: A lint violation fails CI

- GIVEN a commit introduces a lint rule violation
- WHEN CI runs
- THEN the lint job MUST exit non-zero
- AND the overall workflow run MUST be marked failed

#### Scenario: A failing test fails CI

- GIVEN a commit breaks an existing test in `apps/api`
- WHEN CI runs
- THEN the test job MUST exit non-zero
- AND the overall workflow run MUST be marked failed

### Requirement: Dependency caching

CI SHOULD cache the pnpm store keyed on the lockfile hash to reduce install time across runs.

#### Scenario: Cache hit on unchanged lockfile

- GIVEN `pnpm-lock.yaml` is unchanged since the last successful run
- WHEN CI runs
- THEN the pnpm store cache MUST be restored instead of a full re-download
### Requirement: Vendored XSD checksum verification gate

CI MUST run an offline checksum verification step for the `packages/sifen-xsd` vendored schema graph, comparing every file under `packages/sifen-xsd/vendor/` against `checksums.json`, and MUST fail the workflow if any file does not match.

#### Scenario: Vendored XSDs match checksums

- GIVEN a commit where every file under `packages/sifen-xsd/vendor/` matches its recorded sha256 in `checksums.json`
- WHEN CI runs
- THEN the checksum verification step MUST report success

#### Scenario: A tampered vendored XSD fails CI

- GIVEN a commit modifies a file under `packages/sifen-xsd/vendor/` without updating `checksums.json`
- WHEN CI runs
- THEN the checksum verification step MUST exit non-zero
- AND the overall workflow run MUST be marked failed
### Requirement: Test coverage gate

CI MUST run a `coverage` task, using Vitest's v8 coverage provider, for every package that defines tests, and MUST fail the workflow if lines, branches, functions, or statements coverage on that package's non-excluded source falls below 85%.

#### Scenario: Coverage above threshold passes CI

- GIVEN a commit where every tested package's lines/branches/functions/statements coverage is at or above 85%
- WHEN CI runs the `coverage` task
- THEN every package's coverage task MUST report success
- AND the overall workflow run MUST be green

#### Scenario: A coverage regression fails CI

- GIVEN a commit drops a package's line, branch, function, or statement coverage below 85%
- WHEN CI runs the `coverage` task
- THEN the coverage task for that package MUST exit non-zero with a threshold-violation message
- AND the overall workflow run MUST be marked failed

#### Scenario: Exclusions are narrow and justified

- GIVEN a package's coverage configuration excludes a file or directory from the gate
- WHEN the exclusion is reviewed
- THEN it MUST be limited to bootstrap entrypoints, CLI scripts, test fixtures/support files, or type-only declaration output
- AND MUST NOT exclude domain or application logic
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
