import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as migrateNodePostgres } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { createPgliteDatabase, type DatabaseHandle } from '../../src/client.js';
import * as schema from '../../src/schema.js';
import { createPostgresTestDatabase } from './harness.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

interface Journal {
  entries: { tag: string }[];
}

/** A copy of the migrations folder whose journal stops at `tag` (inclusive); the SQL files are symlinked. */
function migrationsUpTo(tag: string): string {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const end = journal.entries.findIndex((entry) => entry.tag === tag);
  if (end < 0) throw new Error(`Unknown migration tag ${tag}`);
  const folder = mkdtempSync(join(tmpdir(), 'migrations-upto-'));
  mkdirSync(join(folder, 'meta'));
  const kept = journal.entries.slice(0, end + 1);
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  for (const entry of kept) {
    symlinkSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

/**
 * A fresh database (pglite, or an isolated database in the postgres testcontainer when
 * `DB_TEST_DRIVER=postgres`) migrated only up to `tag`, inclusive. Seed pre-migration data, then call
 * `handle.migrate()` to apply the remaining migrations on top of it.
 */
export async function createTestDatabaseMigratedTo(tag: string): Promise<DatabaseHandle> {
  const migrationsFolder = migrationsUpTo(tag);
  if (process.env.DB_TEST_DRIVER === 'postgres') {
    const handle = await createPostgresTestDatabase();
    await migrateNodePostgres(handle.db as NodePgDatabase<typeof schema>, { migrationsFolder });
    return handle;
  }
  const handle = createPgliteDatabase();
  await migratePglite(handle.db as PgliteDatabase<typeof schema>, { migrationsFolder });
  return handle;
}
