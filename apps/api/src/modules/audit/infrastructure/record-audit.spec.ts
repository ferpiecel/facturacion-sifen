import { afterEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  createPgliteDatabase,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { REDACTED } from '../domain/redact.js';
import { recordAudit } from './record-audit.js';

describe('recordAudit', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('writes an entry with redacted before/after inside the tenant transaction', async () => {
    const testHandle = createPgliteDatabase();
    handle = testHandle;
    await testHandle.migrate();
    const [tenant] = await testHandle.db.insert(tenants).values({ name: 'Acme' }).returning();
    const tenantId = tenant.id;

    await withTenantTransaction(testHandle.db, tenantId, (tx) =>
      recordAudit(tx, {
        tenantId,
        actor: { type: 'api_key', id: 'key-1' },
        action: 'api_key.issue',
        entity: { type: 'api_key', id: 'k-9' },
        before: null,
        after: { label: 'CI', secret_hash: 'argon2-hash' },
      }),
    );

    const rows = await withTenantTransaction(testHandle.db, tenantId, (tx) =>
      tx.select().from(auditLog),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId,
      actorType: 'api_key',
      actorId: 'key-1',
      action: 'api_key.issue',
      entityType: 'api_key',
      entityId: 'k-9',
      before: null,
      after: { label: 'CI', secret_hash: REDACTED },
    });
  });
});
