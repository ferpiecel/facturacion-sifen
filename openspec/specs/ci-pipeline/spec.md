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
