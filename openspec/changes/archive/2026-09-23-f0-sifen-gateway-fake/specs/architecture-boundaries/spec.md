## ADDED Requirements

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
