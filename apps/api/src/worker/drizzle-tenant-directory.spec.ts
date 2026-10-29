import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteDatabase, tenants, type Database, type DatabaseHandle } from '@sifen/db';
import { sql } from 'drizzle-orm';
import {
  createDrizzleTenantDirectory,
  createDrizzleTenantEnvironments,
} from './tenant-directory.js';

async function auditTrail(db: Database) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE platform_admin`);
    const result = (await tx.execute(
      sql`select actor, purpose from platform_audit_log order by seq`,
    )) as { rows: { actor: string; purpose: string }[] };
    return result.rows;
  });
}

/** Spec: HU-E6-02 (S5e). The worker lists every tenant through the platform_admin role. */
describe('DrizzleTenantDirectory', () => {
  let handle: DatabaseHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('lists all tenant ids across tenants, in a stable order', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const rows = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
      .returning({ id: tenants.id });

    const ids = await createDrizzleTenantDirectory(handle.db).tenantIds();

    expect(ids).toEqual(rows.map((row) => row.id).sort());
  });

  it('audits the listing as a system job, once per throttle window across cycles', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const directory = createDrizzleTenantDirectory(handle.db);

    await directory.tenantIds();
    await directory.tenantIds();

    expect(await auditTrail(handle.db)).toEqual([
      { actor: 'system:worker', purpose: 'worker:tenant-directory' },
    ]);
  });

  it('audits the environment lookup as a system job', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();

    await createDrizzleTenantEnvironments(handle.db).environmentOf(tenant.id);

    expect(await auditTrail(handle.db)).toEqual([
      { actor: 'system:worker', purpose: 'worker:tenant-environment' },
    ]);
  });
});
