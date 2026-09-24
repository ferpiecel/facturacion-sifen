import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createNodePostgresDatabase,
  createPgliteDatabase,
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
