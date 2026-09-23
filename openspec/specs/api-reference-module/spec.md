# API Reference Module Specification

## Purpose

Bootstrap `apps/api` as a NestJS + Fastify application and provide a canonical `health` module demonstrating the hexagonal layout (domain/application/infrastructure with a port and adapter) that later modules will replicate.

## Requirements

### Requirement: NestJS + Fastify bootstrap

`apps/api` MUST bootstrap a NestJS application using the Fastify HTTP adapter and MUST start listening on a configurable port.

#### Scenario: Application starts successfully

- GIVEN `apps/api` dependencies are installed
- WHEN the application is started (e.g. `pnpm --filter api start`)
- THEN the process MUST bind to the configured port without throwing
- AND MUST log a startup confirmation

### Requirement: Health endpoint

The `health` module MUST expose `GET /health` returning HTTP 200 with a JSON body indicating service status.

#### Scenario: Health check succeeds

- GIVEN the API application is running
- WHEN an HTTP client sends `GET /health`
- THEN the response status MUST be 200
- AND the response body MUST include a status field indicating the service is up

### Requirement: Hexagonal module structure

The `health` module MUST be organized as `domain/`, `application/`, and `infrastructure/` subdirectories, with at least one port interface defined in `application/` and one adapter implementing it in `infrastructure/`.

#### Scenario: Port and adapter are wired via DI

- GIVEN `application/` defines a `HealthCheckPort` interface
- AND `infrastructure/` provides a concrete adapter implementing `HealthCheckPort`
- WHEN the Nest module is bootstrapped
- THEN the adapter MUST be bound to the port token in the module's providers
- AND MUST be injectable wherever the port is requested

### Requirement: Reference tests

The `health` module MUST include example tests covering the port/adapter wiring, including at least one test that resolves the adapter through Nest's dependency injection container.

#### Scenario: DI-dependent test passes

- GIVEN a Vitest test builds a `Test.createTestingModule` for the `health` module
- WHEN the test resolves `HealthCheckPort` from the testing module
- THEN it MUST receive the concrete adapter instance
- AND the test MUST pass
