import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { createDrizzleTenantEnvironment } from './drizzle-tenant-environment.js';

describe('createDrizzleTenantEnvironment', () => {
  let handle: DatabaseHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("reads the tenant's own environment inside its tenant scope", async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [test, prod] = await handle.db
      .insert(tenants)
      .values([
        { name: 'A', environment: 'test' },
        { name: 'B', environment: 'production' },
      ])
      .returning({ id: tenants.id });
    const reader = createDrizzleTenantEnvironment(handle.db);
    await expect(reader.environmentOf(test.id)).resolves.toBe('test');
    await expect(reader.environmentOf(prod.id)).resolves.toBe('production');
  });

  it('fails for an unknown tenant instead of defaulting', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    await expect(
      createDrizzleTenantEnvironment(handle.db).environmentOf(
        '00000000-0000-4000-8000-000000000000',
      ),
    ).rejects.toThrow('tenant not found');
  });
});
