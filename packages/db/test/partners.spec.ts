import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '../src/client.js';
import { partners, tenants } from '../src/schema.js';
import { createTestDatabase } from './support/harness.js';

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/** Spec: HU-E1-05 / ADR-0014. Shape only: partner RLS/visibility is HU-E1-06. */
describe('partners', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('a tenant can be created without a partner', async () => {
    handle = await createTestDatabase();

    const [row] = await handle.db.insert(tenants).values({ name: 'Direct Tenant' }).returning();

    expect(required(row, 'tenant was not inserted').partnerId).toBeNull();
  });

  it('a tenant can be created with a partner', async () => {
    handle = await createTestDatabase();

    const [partner] = await handle.db.insert(partners).values({ name: 'Partner A' }).returning();
    const partnerId = required(partner, 'partner was not inserted').id;

    const [tenant] = await handle.db
      .insert(tenants)
      .values({ name: 'Partner Tenant', partnerId })
      .returning();

    expect(required(tenant, 'tenant was not inserted').partnerId).toBe(partnerId);
  });

  it('app_user has no grant on partners (HU-E1-06 is a later story)', async () => {
    handle = await createTestDatabase();

    const error: unknown = await handle.db
      .transaction(async (tx: Database) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(sql`select 1 from partners`);
      })
      .catch((caught: unknown) => caught);

    const cause = error instanceof Error ? (error.cause ?? error) : error;
    expect(String(cause)).toMatch(/permission denied/i);
  });
});
