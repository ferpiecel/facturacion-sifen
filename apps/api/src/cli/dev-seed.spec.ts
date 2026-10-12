import {
  createPgliteDatabase,
  documents,
  tenantMemberships,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
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

  it('seeds the demo tenant, the owner and one document per status, and is idempotent', async () => {
    const first = await runDevSeed(handle.db);
    const second = await runDevSeed(handle.db);

    expect(first.apiKey).toMatch(/^sk_test_/);
    expect(first.documentsCreated).toBe(6);
    expect(second).toEqual({ tenantId: first.tenantId, apiKey: null, documentsCreated: 0 });
    expect(await handle.db.select().from(tenants)).toHaveLength(1);
    expect(await handle.db.select().from(tenantMemberships)).toHaveLength(1);
    const rows = await handle.db.select().from(documents);
    expect(rows.map((row) => row.status).sort()).toEqual([
      'approved',
      'approved',
      'approved_with_observations',
      'cancelled',
      'queued',
      'rejected',
    ]);
    // A running worker must not pick the queued demo document up and turn it into "submitted".
    const queued = rows.find((row) => row.status === 'queued');
    expect(queued?.nextTransmissionAt?.getTime()).toBeGreaterThan(
      Date.now() + 30 * 24 * 3600 * 1000,
    );
    expect(rows.every((row) => row.signedXml?.includes('<Signature'))).toBe(true);
  }, 60_000);

  it('prints the login and never hides the password from the operator', () => {
    const text = formatDevSeedResult({ tenantId: 't', apiKey: 'sk_test_x', documentsCreated: 1 });
    expect(text).toContain(DEMO.email);
    expect(text).toContain(DEMO.password);
    expect(text).toContain('sk_test_x');
  });
});
