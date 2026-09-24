import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzleNodePostgres, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePostgres } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema.js';

// Resolves to `packages/db/migrations` whether this module runs from
// `src/` (ts-node/vitest) or from the compiled `dist/` output, since both
// sit exactly one directory below the package root.
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Common read/query surface shared by both drivers. `withTenantTransaction`
 * and application code depend on this type, never on the driver-specific
 * `PgliteDatabase`/`NodePgDatabase` subtypes.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-memory (or on-disk, if `dataDir` is given) Postgres via WASM. Used as
 * the default local/test driver so the suite runs without Docker.
 */
export function createPgliteDatabase(dataDir?: string): DatabaseHandle {
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });

  return {
    db,
    async migrate() {
      await migratePglite(db as PgliteDatabase<typeof schema>, {
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * Real Postgres via `pg`. Used against a `testcontainers` instance in CI
 * (`DB_TEST_DRIVER=postgres`) and, later, in production.
 */
export function createNodePostgresDatabase(connectionString: string): DatabaseHandle {
  const pool = new Pool({ connectionString });
  // An idle pooled client can emit 'error' on its own (e.g. the server
  // restarts or drops the connection) outside of any query the app made.
  // Node's EventEmitter rethrows an unhandled 'error' event, which would
  // otherwise crash the whole process for an error the app never caused
  // and cannot avoid; log it instead and let the pool recycle the client.
  pool.on('error', (error) => {
    console.error('Unexpected error on idle pg Pool client', error);
  });
  const db = drizzleNodePostgres(pool, { schema });

  return {
    db,
    /* v8 ignore next 5 -- requires a reachable Postgres instance; exercised
     * only by `test:postgres` against the testcontainers database (no
     * Docker on this coverage run). */
    async migrate() {
      await migrateNodePostgres(db as NodePgDatabase<typeof schema>, {
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    },
    async close() {
      await pool.end();
    },
  };
}
