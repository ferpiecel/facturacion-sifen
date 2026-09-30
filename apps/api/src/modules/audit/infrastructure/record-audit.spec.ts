import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  createPgliteDatabase,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import type { AuditEntry } from '../application/ports/record-audit.port.js';
import { REDACTED } from '../domain/redact.js';
import { recordAudit } from './record-audit.js';

const entry: AuditEntry = {
  actor: { type: 'api_key', id: 'key-1' },
  action: 'api_key.issue',
  entity: { type: 'api_key', id: 'k-9' },
  before: null,
  after: { label: 'CI', secret_hash: 'argon2-hash', nested: { csc: '0001' } },
};

describe('recordAudit', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [acme, other] = await handle.db
      .insert(tenants)
      .values([{ name: 'Acme' }, { name: 'Other' }])
      .returning();
    tenantId = acme.id;
    otherTenantId = other.id;
  });

  afterEach(async () => {
    await handle.close();
  });

  const readRows = () =>
    withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(auditLog));

  it('writes the entry with redacted before/after', async () => {
    await withTenantTransaction(handle.db, tenantId, (tx) => recordAudit(tx, entry));

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId,
      actorType: 'api_key',
      actorId: 'key-1',
      action: 'api_key.issue',
      entityType: 'api_key',
      entityId: 'k-9',
      before: null,
      after: { label: 'CI', secret_hash: REDACTED, nested: { csc: REDACTED } },
    });
  });

  it('takes tenant_id from the transaction context, ignoring a payload tenantId', async () => {
    const forged = { ...entry, tenantId: otherTenantId } as AuditEntry;

    await withTenantTransaction(handle.db, tenantId, (tx) => recordAudit(tx, forged));

    const rows = await readRows();
    expect(rows.map((row) => row.tenantId)).toEqual([tenantId]);
  });

  it('fails loudly, writing nothing, when there is no tenant context', async () => {
    await expect(handle.db.transaction((tx) => recordAudit(tx, entry))).rejects.toThrow(
      'recordAudit requires a tenant transaction context',
    );

    expect(await readRows()).toHaveLength(0);
  });

  it('participates in the caller transaction: a rollback leaves no audit row', async () => {
    await expect(
      withTenantTransaction(handle.db, tenantId, async (tx) => {
        await recordAudit(tx, entry);
        throw new Error('business write failed');
      }),
    ).rejects.toThrow('business write failed');

    expect(await readRows()).toHaveLength(0);
  });
});
