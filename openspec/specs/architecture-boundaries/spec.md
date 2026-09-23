# Architecture Boundaries Specification

## Purpose

Enforce the hexagonal layering defined in ADR-0003 at the tooling level using dependency-cruiser, so `domain/` and `application/` layers stay framework-free and dependency direction violations are caught automatically.

## Requirements

### Requirement: Framework isolation in domain and application layers

The system MUST fail dependency-cruiser validation when a file under any `domain/` or `application/` directory imports `@nestjs/*`, `fastify`, `drizzle-orm`, or `bullmq`.

#### Scenario: Domain file imports a NestJS package

- GIVEN a file at `apps/api/src/modules/health/domain/health.entity.ts` imports `@nestjs/common`
- WHEN `pnpm dependency-cruiser` (or the equivalent CI job) runs
- THEN dependency-cruiser MUST report a rule violation
- AND MUST exit with a non-zero code

#### Scenario: Domain file has no forbidden imports

- GIVEN every file under `domain/` and `application/` imports only framework-free code
- WHEN dependency-cruiser runs
- THEN it MUST report zero violations for the framework-isolation rule
- AND MUST exit with code 0

### Requirement: Layer dependency direction

The system MUST fail dependency-cruiser validation when a `domain/` file imports from `application/` or `infrastructure/`, or when an `application/` file imports from `infrastructure/`.

#### Scenario: Domain imports infrastructure

- GIVEN a file under `domain/` imports a class from a sibling `infrastructure/` directory
- WHEN dependency-cruiser runs
- THEN it MUST report a layering-direction violation and exit non-zero

#### Scenario: Application imports infrastructure

- GIVEN a file under `application/` imports a repository implementation from `infrastructure/`
- WHEN dependency-cruiser runs
- THEN it MUST report a layering-direction violation and exit non-zero

#### Scenario: Infrastructure imports application (allowed direction)

- GIVEN a file under `infrastructure/` imports a port interface defined in `application/`
- WHEN dependency-cruiser runs
- THEN no violation MUST be reported for this import

### Requirement: CI enforcement

The dependency-cruiser check MUST run as part of the CI pipeline (`ci-pipeline` capability) and block merge on violation.
### Requirement: Framework isolation in packages/sifen-gateway

The system MUST fail dependency-cruiser validation when a file under `packages/sifen-gateway/` imports `@nestjs/*`, `fastify`, `drizzle-orm`, or `bullmq`.

#### Scenario: sifen-gateway file imports a framework package

- GIVEN a file at `packages/sifen-gateway/src/index.ts` imports `@nestjs/common`
- WHEN `pnpm dependency-cruiser` (or the equivalent CI job) runs
- THEN dependency-cruiser MUST report a rule violation
- AND MUST exit with a non-zero code

#### Scenario: sifen-gateway has no forbidden imports

- GIVEN every file under `packages/sifen-gateway/` imports only framework-free code
- WHEN dependency-cruiser runs
- THEN it MUST report zero violations for the framework-isolation rule
- AND MUST exit with code 0
