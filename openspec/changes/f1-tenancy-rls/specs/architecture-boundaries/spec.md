# Delta for Architecture Boundaries

## ADDED Requirements

### Requirement: Framework isolation in packages/db

The system MUST fail dependency-cruiser validation when a file under `packages/db/` imports `@nestjs/*`, `fastify`, or `bullmq`.

#### Scenario: packages/db file imports a framework package

- GIVEN a file at `packages/db/src/index.ts` imports `@nestjs/common`
- WHEN `pnpm dependency-cruiser` (or the equivalent CI job) runs
- THEN dependency-cruiser MUST report a rule violation
- AND MUST exit with a non-zero code

#### Scenario: packages/db has no forbidden imports

- GIVEN every file under `packages/db/` imports only framework-free code (including `drizzle-orm`, which is allowed)
- WHEN dependency-cruiser runs
- THEN it MUST report zero violations for the framework-isolation rule
- AND MUST exit with code 0
