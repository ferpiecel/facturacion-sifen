import { createPgliteDatabase, tenantMemberships, tenants, type DatabaseHandle } from '@sifen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO, formatDevSeedResult, runDevSeed } from './dev-seed.js';

describe('runDevSeed', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('seeds the demo tenant and its owner, and is idempotent', async () => {
    const first = await runDevSeed(handle.db);
    const second = await runDevSeed(handle.db);

    expect(first.apiKey).toMatch(/^sk_test_/);
    expect(second).toEqual({ tenantId: first.tenantId, apiKey: null });
    expect(await handle.db.select().from(tenants)).toHaveLength(1);
    expect(await handle.db.select().from(tenantMemberships)).toHaveLength(1);
  }, 60_000);

  it('prints the login and the API key', () => {
    const text = formatDevSeedResult({ tenantId: 't', apiKey: 'sk_test_x' });
    expect(text).toContain(DEMO.email);
    expect(text).toContain(DEMO.password);
    expect(text).toContain('sk_test_x');
  });
});
