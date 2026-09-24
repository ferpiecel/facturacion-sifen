import { apiKeys, createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlApiKeyLookupAdapter } from './sql-api-key-lookup.adapter.js';

const KEY_ID = 'a'.repeat(24);

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

describe('SqlApiKeyLookupAdapter', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = createPgliteDatabase();
    await handle.migrate();

    const [tenant] = await handle.db.insert(tenants).values({ name: 'Acme SA' }).returning();
    const tenantId = required(tenant, 'tenant was not inserted').id;

    const [row] = await handle.db
      .insert(apiKeys)
      .values({
        tenantId,
        keyId: KEY_ID,
        environment: 'live',
        secretHash: 'stored-hash',
        scopes: ['documents:write'],
      })
      .returning();

    return { db: handle.db, tenantId, id: required(row, 'api key was not inserted').id };
  }

  it('resolves an active key by its key id', async () => {
    const { db, tenantId, id } = await seed();
    const adapter = new SqlApiKeyLookupAdapter(db);

    const resolved = await adapter.resolveByKeyId(KEY_ID);

    expect(resolved).toEqual({
      id,
      tenantId,
      secretHash: 'stored-hash',
      scopes: ['documents:write'],
      environment: 'live',
    });
  });

  it('returns null for an unknown key id', async () => {
    const { db } = await seed();
    const adapter = new SqlApiKeyLookupAdapter(db);

    await expect(adapter.resolveByKeyId('b'.repeat(24))).resolves.toBeNull();
  });

  it('touchLastUsed sets last_used_at on the resolved key', async () => {
    const { db, id } = await seed();
    const adapter = new SqlApiKeyLookupAdapter(db);

    await adapter.touchLastUsed(id);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('touchLastUsed never rejects, even for an id that does not exist', async () => {
    const { db } = await seed();
    const adapter = new SqlApiKeyLookupAdapter(db);

    await expect(
      adapter.touchLastUsed('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });
});
