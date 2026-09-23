# Test Runner Specification

## Purpose

Provide a workspace-wide Vitest test runner capable of executing tests against NestJS modules — including decorator-metadata-dependent dependency injection — so `strict_tdd` can be enabled.

## Requirements

### Requirement: Vitest configured with decorator metadata support

The workspace MUST configure Vitest with `unplugin-swc` (or equivalent) so TypeScript decorator metadata required by NestJS dependency injection is preserved during test compilation.

#### Scenario: Nest DI resolves inside a Vitest test

- GIVEN a NestJS testing module built with `Test.createTestingModule` that injects a service via constructor parameter decorated with `@Injectable`
- WHEN the test file is run via `pnpm turbo run test` (Vitest)
- THEN the module MUST compile and the injected service instance MUST be resolved correctly
- AND the test MUST pass

### Requirement: Workspace-wide test command

Each workspace package that has tests MUST expose a `test` script runnable via `pnpm turbo run test` from the repo root, executing that package's Vitest suite.

#### Scenario: Running tests across the workspace

- GIVEN `apps/api` has a Vitest suite with at least one passing test
- WHEN `pnpm turbo run test` is run from the repo root
- THEN Vitest MUST execute the suite and report all tests passing
- AND the command MUST exit 0

#### Scenario: A failing test is reported

- GIVEN a test in `apps/api` asserts an incorrect value
- WHEN `pnpm turbo run test` is run
- THEN Vitest MUST report the failing test
- AND the command MUST exit non-zero

### Requirement: strict_tdd enablement

Once the test runner is verified working end-to-end (including a DI-dependent test), `openspec/config.yaml` MUST set `strict_tdd: true` and `apply.tdd: true` with a non-empty `test_command`.

#### Scenario: Config reflects enabled strict TDD

- GIVEN the test runner passes the DI-dependent health module test
- WHEN `openspec/config.yaml` is inspected
- THEN `strict_tdd` MUST be `true`
- AND `apply.tdd` MUST be `true`
- AND `apply.test_command` and `verify.test_command` MUST be non-empty and match the real workspace test command
