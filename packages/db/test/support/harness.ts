import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { SQLWrapper } from 'drizzle-orm';
import {
  createNodePostgresDatabase,
  createPgliteDatabase,
  type Database,
  type DatabaseHandle,
} from '../../src/client.js';

/**
 * Returns a migrated {@link DatabaseHandle} for the test suite.
 *
 * - Default (no env flag): in-memory `pglite`, no Docker required.
 * - `DB_TEST_DRIVER=postgres`: a fresh database inside the `postgres:16`
 *   testcontainer started once by `global-setup.ts`, so every spec file
 *   runs against an isolated database in the same container.
 *
 * Both branches run the exact same migrations and expose the exact same
 * `DatabaseHandle`, so spec files never branch on the driver.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  if (process.env.DB_TEST_DRIVER === 'postgres') {
    const handle = await createPostgresTestDatabase();
    await handle.migrate();
    return handle;
  }

  const handle = createPgliteDatabase();
  await handle.migrate();
  return handle;
}

async function createPostgresTestDatabase(): Promise<DatabaseHandle> {
  const baseUrl = process.env.DB_TEST_POSTGRES_URL;
  if (!baseUrl) {
    throw new Error(
      'DB_TEST_POSTGRES_URL is not set. global-setup.ts did not start the postgres:16 testcontainer.',
    );
  }

  const databaseName = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: baseUrl });
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return createNodePostgresDatabase(url.toString());
}

/**
 * Runs a raw SQL query and returns its rows, typed as `T[]`.
 *
 * `Database.execute` is typed through drizzle's abstract `PgQueryResultHKT`,
 * so its return type does not resolve to a concrete `{ rows: T[] }` shape
 * at the `Database` alias level, even though both drivers return exactly
 * that at runtime. This helper isolates the one intentional cast the
 * isolation and RLS drift-check specs need to read diagnostic query
 * results.
 */
export async function queryRows<T>(db: Database, query: SQLWrapper): Promise<T[]> {
  const result = (await db.execute(query)) as { rows: T[] };
  return result.rows;
}
