import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { createDrizzleTenantDirectory } from './tenant-directory.js';

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
});
