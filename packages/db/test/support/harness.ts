import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../src/schema.js';
import type { SQLWrapper } from 'drizzle-orm';
import {
  createNodePostgresDatabase,
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

  return createPgliteFromTemplate();
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * Applying every migration on a fresh WASM Postgres costs seconds of CPU
 * and tens of MB per instance; doing it for each of the ~40 databases a
 * worker creates, across parallel workers, starved the suite (30 s test
 * timeouts) and exhausted memory (workers SIGKILLed). Migrate once per
 * worker process, snapshot the data directory, and boot every later
 * database from that snapshot. `migrate()` on a snapshot is a cheap no-op
 * (drizzle's journal is part of the dump), so specs that call it still work.
 */
let migratedTemplate: Promise<Blob> | undefined;

function migrateClient(client: PGlite): Promise<void> {
  return migratePglite(drizzlePglite(client, { schema }), {
    migrationsFolder: MIGRATIONS_FOLDER,
  });
}

async function getMigratedTemplate(): Promise<Blob> {
  migratedTemplate ??= (async () => {
    const seed = new PGlite();
    try {
      await migrateClient(seed);
      return seed.dumpDataDir('none');
    } finally {
      await seed.close();
    }
  })();
  return migratedTemplate;
}

async function createPgliteFromTemplate(): Promise<DatabaseHandle> {
  const client = new PGlite({ loadDataDir: await getMigratedTemplate() });
  const db = drizzlePglite(client, { schema });
  return {
    db,
    migrate: () => migrateClient(client),
    close: () => client.close(),
  };
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
  const handle = createNodePostgresDatabase(url.toString());
  databaseUrls.set(handle, url);
  return handle;
}

const databaseUrls = new WeakMap<DatabaseHandle, URL>();

/** Runtime connection (`app_login`, see `global-setup.ts`) to `owner`'s database. Postgres only. */
export function connectAsRuntime(owner: DatabaseHandle): DatabaseHandle {
  return connectAs(owner, 'app_login', 'app_login');
}

/**
 * Connects to `owner`'s database as `username`. `role`, when given, is a
 * startup `SET ROLE` (libpq `-c role=`), so `session_user` stays `username`
 * while `current_user` becomes `role`. Postgres only.
 */
export function connectAs(
  owner: DatabaseHandle,
  username: string,
  password: string,
  role?: string,
): DatabaseHandle {
  const ownerUrl = databaseUrls.get(owner);
  if (!ownerUrl) {
    throw new Error('connectAs requires a handle from createTestDatabase on postgres');
  }
  const url = new URL(ownerUrl);
  url.username = username;
  url.password = password;
  if (role) {
    url.searchParams.set('options', `-c role=${role}`);
  }
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
