import { createPgliteDatabase, type Database, type DatabaseHandle } from '@sifen/db';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { asPlatformAdmin } from './platform-admin.js';

/** Spec: HU-E15-01, billing writes run as `platform_admin` (forced RLS), never as the owner. */
describe('asPlatformAdmin', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('runs the callback as platform_admin and leaves the session role untouched afterwards', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const roleOf = async (db: Database) =>
      ((await db.execute(sql`select current_user as "role"`)) as { rows: { role: string }[] })
        .rows[0].role;
    const before = await roleOf(handle.db);

    const inside = await asPlatformAdmin(handle.db, { purpose: 'test', scope: ['none'] }, (tx) =>
      roleOf(tx),
    );

    expect(inside).toBe('platform_admin');
    expect(await roleOf(handle.db)).toBe(before);
  });
});
