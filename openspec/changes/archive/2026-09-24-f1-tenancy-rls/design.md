# Design: F1 Tenancy with PostgreSQL RLS

## Technical Approach

A framework-free `@sifen/db` package (ESM, `nodenext`, same scripts/coverage as `sifen-gateway`) owns the Drizzle schema, migrations, RLS SQL and the single transaction entry point `withTenantTransaction`. `apps/api` adds nestjs-cls plus a `tenancy` module (hexagonal layout like `health`) that resolves the tenant into CLS and runs work through that entry point. Delivered in 3 chained PRs.

## Architecture Decisions

| Topic | Option / tradeoff | Decision |
|---|---|---|
| GUC name | Proposal says `app.current_tenant`; accepted ADR-0005/0006 say `app.current_tenant` | **`app.current_tenant`** (ADR governs; review flags ADR drift) |
| Set tenant | `SET LOCAL ... = '${id}'` (injection) vs `set_config($1, true)` | **`select set_config('app.current_tenant', $1, true)`** bound param, after UUID validation |
| Policy expr | `current_setting(...)::uuid` errors on `''` after reset | **`tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid`**, `USING` + `WITH CHECK`, `TO app_user` → deny by default |
| Roles | Created by bootstrap script vs migration | **Migration `0001_rls.sql`**: idempotent `DO` block creates `NOLOGIN` `app_user`, `platform_admin` (no `BYPASSRLS`). Login users, passwords and `GRANT app_user TO <login>` are per-environment bootstrap (out of scope; tests connect as owner and `SET LOCAL ROLE`) |
| `platform_admin` | `BYPASSRLS` needs superuser | **Explicit policy `TO platform_admin USING (true)`**; not wired to any request path |
| RLS DDL | drizzle-kit cannot emit policies | `drizzle-kit generate` → `0000_*`; **`drizzle-kit generate --custom --name rls`** → `0001_rls.sql` (registered in journal). Manual `migrations/rollback/0001_rls.down.sql` outside journal |
| Tx plugin (ADR-0006) | `@nestjs-cls/transactional` adapter: versions unverified | **Defer**; one singleton `TenantTransactionRunner` is the single point. No `Scope.REQUEST` (ADR-0006 rejects it) |
| Header guard | Global guard vs opt-in | **Opt-in `TestTenantHeaderGuard`** (`x-tenant-id`), throws at construction when `NODE_ENV=production`; no production route uses it. Removed by HU-E1-04 |
| DB in `AppModule` | Wire `DATABASE_URL` now vs later | **Later**: `AppModule` imports only `ClsModule.forRoot({ global: true, middleware: { mount: true } })`; `TenancyModule.register({ database })` is consumed from HU-E1-04 on |
| Worker base | Import bullmq in db pkg vs structural type | **`TenantAwareProcessor` in `@sifen/db`**, job typed structurally `{ data: { tenantId: string } }` |
| Boundaries | Root rule would fire inside `packages/db` (local paths are `src/`) | Local configs: `packages/db` forbids `@nestjs`, `fastify`, `bullmq`, `ioredis`, `reflect-metadata`; new `apps/api/.dependency-cruiser.cjs` forbids `drizzle-orm`, `pg`, `@electric-sql/`, `@sifen/db` outside `modules/*/infrastructure/` and `*.module.ts` |

## Data Flow

    HTTP ─→ ClsMiddleware ─→ TestTenantHeaderGuard ─(cls.set tenantId)─→ Controller
                                                                          │
    Repository (infra) ─→ TenantTransactionRunner.run(fn) ─(cls.get; missing → MissingTenantContextError)
                                   │
                         withTenantTransaction(db, id, fn)
                           BEGIN; set_config(...,true); SET LOCAL ROLE app_user; fn(tx); COMMIT
    Job ─→ TenantAwareProcessor.process(job) ─→ withTenantTransaction(db, job.data.tenantId, handle)

## File Changes

| File | Action | PR |
|---|---|---|
| `packages/db/{package.json,tsconfig*.json,vitest.config.ts,.dependency-cruiser.cjs,drizzle.config.ts}` | Create | 1 |
| `packages/db/src/schema.ts` (`tenants`, `tenant_probe`, `TENANT_TABLES`) | Create | 1 |
| `packages/db/src/client.ts` (`createPgliteDatabase`, `createNodePostgresDatabase` → `DatabaseHandle`) | Create | 1 |
| `packages/db/migrations/0000_*.sql` + `meta/` (generated) | Create | 1 |
| `packages/db/test/support/harness.ts`, `test/support/global-setup.ts` | Create | 1 |
| `packages/db/migrations/0001_rls.sql`, `rollback/0001_rls.down.sql` | Create | 2 |
| `packages/db/src/{tenant-id.ts,tenant-transaction.ts,errors.ts,index.ts}` | Create | 2 |
| `packages/db/test/{isolation,rls-coverage}.spec.ts` | Create | 2 |
| `.github/workflows/ci.yml` (job `db-postgres`) | Modify | 2 |
| `packages/db/src/tenant-aware-processor.ts` + spec | Create | 3 |
| `apps/api/src/modules/tenancy/**`, `apps/api/src/app.module.ts`, `apps/api/package.json` | Create/Modify | 3 |
| `apps/api/.dependency-cruiser.cjs` (+ `depcruise` script) | Create/Modify | 3 |

## Interfaces / Contracts

```ts
export interface DatabaseHandle { db: Database; migrate(): Promise<void>; close(): Promise<void> }
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
export function withTenantTransaction<T>(db: Database, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>; // InvalidTenantIdError on non-UUID, before BEGIN
export abstract class TenantAwareProcessor<P extends { tenantId: string }, R> {
  protected constructor(db: Database);
  process(job: { data: P }): Promise<R>;
  protected abstract handle(data: P, tx: TenantTx): Promise<R>;
}
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | UUID validation, runner without CLS tenant, guard (missing → 401, invalid → 400, production → throws) | Vitest, no DB |
| Integration | A cannot read/write B; no tenant → 0 rows and insert rejected; `current_setting` empty after commit and rollback; `platform_admin` sees all; drift check: every table with `tenant_id` has `relforcerowsecurity` and a policy | `harness.ts`: pglite in-memory per file (default); `DB_TEST_DRIVER=postgres` → `GenericContainer('postgres:16')` started once in globalSetup, fresh database per file |
| API | Test controller + guard + runner over pglite | `Test.createTestingModule` + Fastify inject |

Coverage: `all: true`, 85% per package holds on pglite. Harness lives in `test/` (not measured). `createNodePostgresDatabase` is covered without Docker (`pg.Pool` is lazy); only its `migrate` branch is Postgres-job-only. CI: new job `db-postgres` runs `pnpm --filter @sifen/db test:postgres`; must be added as a required check.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Tenant isolation threats are covered by the integration suite above.

## Migration / Rollout

No production database exists. Migrations run as owner via `drizzle-kit migrate`. Rollback: revert PR 3 → 2 → 1; `0001_rls.down.sql` for a migrated DB.

PR estimates (hand-written lines): PR1 ≈ 340 (+ generated meta), PR2 ≈ 390, PR3 ≈ 390.

## Open Questions

- [ ] `pg` / `@types/pg` versions not yet verified (apply must `npm view`).
- [ ] Spec must use `app.current_tenant`, or ADR-0005/0006 be amended.
