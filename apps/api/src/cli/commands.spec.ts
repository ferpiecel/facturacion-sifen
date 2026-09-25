import { apiKeys, createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createPartner, createTenant, issueApiKey, revokeApiKey } from './commands.js';

describe('operator CLI command handlers (HU-E1-05)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('createPartner inserts a partner row', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    const { id } = await createPartner(handle.db, 'Partner A');

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('createTenant inserts a tenant without a partner by default', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    const { id } = await createTenant(handle.db, 'Direct Tenant');

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('createTenant links a tenant to a partner when given one', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: partnerId } = await createPartner(handle.db, 'Partner B');

    const { id: tenantId } = await createTenant(handle.db, 'Partner Tenant', partnerId);

    expect(tenantId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('issueApiKey mints a key whose formatted token embeds the printed keyId', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Key Tenant');

    const issued = await issueApiKey(handle.db, {
      tenantId,
      environment: 'test',
      scopes: ['documents:write'],
    });

    expect(issued.formattedKey).toContain(issued.keyId);
    expect(issued.apiKeyId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('revokeApiKey marks the key revoked by its public keyId', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Revoke Tenant');
    const issued = await issueApiKey(handle.db, { tenantId, environment: 'test', scopes: [] });

    await revokeApiKey(handle.db, issued.keyId);

    const [row] = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyId, issued.keyId));
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it('revokeApiKey rejects an unknown keyId instead of reporting success', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    await expect(revokeApiKey(handle.db, 'UnknownKeyId000000000000')).rejects.toThrow(
      'no active api key with keyId UnknownKeyId000000000000',
    );
  });

  it('revokeApiKey rejects an already revoked key and keeps the first revoked_at', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Twice Tenant');
    const issued = await issueApiKey(handle.db, { tenantId, environment: 'test', scopes: [] });
    await revokeApiKey(handle.db, issued.keyId);
    const [first] = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyId, issued.keyId));

    await expect(revokeApiKey(handle.db, issued.keyId)).rejects.toThrow('no active api key');

    const [after] = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyId, issued.keyId));
    expect(after.revokedAt).toEqual(first.revokedAt);
  });
});
