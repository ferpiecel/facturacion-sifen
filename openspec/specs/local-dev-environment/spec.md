# Local Dev Environment Specification

## Purpose

Provide a docker-compose-based local development environment with PostgreSQL 16 and Redis 7, plus an `.env.example` documenting required environment variables. This capability remains partial (HU-E0-02 stays open); it covers infrastructure provisioning only, not schema or app wiring.

## Requirements

### Requirement: Docker Compose services

The repository MUST include a root `docker-compose.yml` defining a `postgres` service pinned to major version 16 and a `redis` service pinned to major version 7.

#### Scenario: Compose stack starts and becomes healthy

- GIVEN Docker is available locally
- WHEN `docker compose up -d` is run from the repo root
- THEN the `postgres` and `redis` containers MUST reach a healthy state (per their configured healthchecks)
- AND `docker compose ps` MUST show both services as `healthy` or `running` with no restart loop

#### Scenario: Postgres accepts connections

- GIVEN the compose stack is up and Postgres is healthy
- WHEN a client connects using the credentials from `.env.example`
- THEN the connection MUST succeed and report PostgreSQL major version 16

#### Scenario: Redis accepts connections

- GIVEN the compose stack is up and Redis is healthy
- WHEN a client sends a `PING` command
- THEN Redis MUST respond `PONG`

### Requirement: Environment variable template

The repository MUST include `.env.example` documenting all environment variables required by the compose services (database URL, Redis URL, credentials), without real secrets.

#### Scenario: Example env file has no secrets

- GIVEN `.env.example` is committed
- WHEN its contents are inspected
- THEN all values MUST be placeholders or non-sensitive defaults, not production credentials

### Requirement: Data persistence via named volumes

The Postgres service SHOULD use a named Docker volume so data survives `docker compose down` (without `-v`).

#### Scenario: Data survives a stack restart

- GIVEN data was written to Postgres while the stack was up
- WHEN `docker compose down` followed by `docker compose up -d` is run
- THEN the previously written data MUST still be present
