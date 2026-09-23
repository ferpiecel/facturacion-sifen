# Monorepo Workspace Specification

## Purpose

Establish the pnpm + Turborepo workspace foundation: pinned Node 22 runtime, workspace layout (`apps/*`, `packages/*`), and shared build/lint/test configuration package that all other packages extend.

## Requirements

### Requirement: Node and package manager pinning

The repository MUST pin Node 22 via `.nvmrc` and `engines.node` in the root `package.json`, and MUST pin the package manager via `packageManager` (corepack-managed pnpm).

#### Scenario: Install with frozen lockfile on Node 22

- GIVEN a clean clone of the repository with Node 22 active (via `.nvmrc` or CI setup-node)
- WHEN `pnpm install --frozen-lockfile` is run
- THEN the install completes successfully with exit code 0
- AND no lockfile drift is reported

#### Scenario: Wrong Node major version is rejected

- GIVEN Node 18 is active instead of Node 22
- WHEN `pnpm install` is run
- THEN pnpm MUST fail or warn due to the `engines.node` constraint

### Requirement: Workspace layout and package resolution

The root `pnpm-workspace.yaml` MUST declare `apps/*` and `packages/*` as workspace members.

#### Scenario: Workspace packages resolve to each other

- GIVEN `apps/api` depends on `packages/config` via `workspace:*`
- WHEN `pnpm install` completes
- THEN `packages/config` MUST be symlinked into `apps/api/node_modules`

### Requirement: Turborepo task orchestration

The root `turbo.json` MUST define `lint`, `typecheck`, and `test` pipeline tasks runnable across all workspace packages via `pnpm turbo run <task>`.

#### Scenario: Running a task across the workspace

- GIVEN the workspace contains `apps/api` and `packages/config`
- WHEN `pnpm turbo run lint typecheck test` is run from the repo root
- THEN Turborepo MUST execute the task in every package that defines it
- AND MUST exit non-zero if any package's task fails

### Requirement: Shared base configuration package

`packages/config` MUST export a base `tsconfig.json`, an ESLint flat config with `typescript-eslint`, and a Prettier config, consumable by extension from other packages.

#### Scenario: A workspace package extends the shared tsconfig

- GIVEN `apps/api/tsconfig.json` extends `packages/config`'s base tsconfig
- WHEN `tsc --noEmit` is run inside `apps/api`
- THEN compiler options from the shared base MUST apply (e.g. `strict: true`)

#### Scenario: Lint uses the shared ESLint config

- GIVEN a `.ts` file in `apps/api` violates a `typescript-eslint` rule from the shared config
- WHEN `pnpm turbo run lint` is run
- THEN the lint task MUST fail with a non-zero exit code
