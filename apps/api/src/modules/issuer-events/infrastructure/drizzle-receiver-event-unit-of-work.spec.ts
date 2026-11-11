import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  issuerEvents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { seedIssuer } from '../../../../test/support/credit-note-fixture.js';
import { buildCdc } from '../../emission/domain/cdc.js';
import {
  ReceiverEventRefusedError,
  createRegisterReceiverEvent,
} from '../application/register-receiver-event.js';
import { createDrizzleReceiverEventUnitOfWork } from './drizzle-receiver-event-unit-of-work.js';

const CDC = buildCdc({
  documentType: '01',
  rucBase: '80069563',
  rucDv: 1,
  establishment: '001',
  point: '001',
  documentNumber: '0000007',
  taxpayerType: 1,
  issueDate: '2026-10-01',
  emissionType: 1,
  securityCode: '123456789',
});

/** Spec: HU-E9-01. The receiver event command against a real (pglite) database. */
describe('RegisterReceiverEvent with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let keySeq = 0;
  const register = (now = new Date('2026-10-20T12:00:00Z')) =>
    createRegisterReceiverEvent({
      unitOfWork: createDrizzleReceiverEventUnitOfWork(handle.db),
      now: () => now,
    });
  const request = (body: Record<string, unknown>, tenant = tenantId) => ({
    tenantId: tenant,
    actor: { type: 'api_key', id: 'key-1' } as const,
    body: { cdc: CDC, issuedAt: '2026-10-01T10:00:00', ...body },
    idempotencyKey: `recv-${String(++keySeq)}`,
  });
  const events = (tenant = tenantId) =>
    withTenantTransaction(handle.db, tenant, (tx) => tx.select().from(issuerEvents));

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
    await seedIssuer(handle.db, tenantId);
    await seedIssuer(handle.db, otherTenantId);
  });

  afterEach(async () => {
    await handle.close();
  });

  it('stores a pending conformity over a foreign CDC, with the next event id, and audits it', async () => {
    const result = await register()(request({ kind: 'conformity', conformityType: 'total' }));

    const [event] = await events();
    expect(event).toMatchObject({
      id: result.eventId,
      kind: 'conformity',
      targetCdc: CDC,
      documentId: null,
      reason: null,
      status: 'pending',
      environment: 'test',
      receiverData: { issuedAt: '2026-10-01T10:00:00', conformityType: 'total' },
    });
    expect(event.eventId).toBeGreaterThan(0n);
    const audit = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'receiver_event.registered')),
    );
    expect(audit).toHaveLength(1);
  });

  it('copies the tenant RUC and legal name into an unawareness', async () => {
    await register()(
      request({
        kind: 'unawareness',
        reason: 'No solicité este documento',
        receivedAt: '2026-10-02T09:00:00',
      }),
    );

    const [event] = await events();
    expect(event.receiverData).toMatchObject({
      receiver: { ruc: '80069563-1', name: 'Empresa SA' },
    });
  });

  it('refuses a second conformity of the same type and lets a partial one precede the total', async () => {
    const partial = {
      kind: 'conformity',
      conformityType: 'partial',
      estimatedReceiptAt: '2026-10-05T00:00:00',
    };
    await register()(request(partial));
    await register()(request({ kind: 'conformity', conformityType: 'total' }));

    await expect(
      register()(request({ kind: 'conformity', conformityType: 'total' })),
    ).rejects.toBeInstanceOf(ReceiverEventRefusedError);
    expect(await events()).toHaveLength(2);
  });

  it('counts only the events of this tenant and lets a refused event be requested again', async () => {
    await register()(
      request({ kind: 'disconformity', reason: 'Mercadería dañada' }, otherTenantId),
    );
    const mine = await register()(request({ kind: 'disconformity', reason: 'Mercadería dañada' }));

    await handle.db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: '<g/>', signedAt: new Date() })
      .where(eq(issuerEvents.id, mine.eventId));
    await handle.db
      .update(issuerEvents)
      .set({ status: 'rejected', responseCode: 'LOC-XSD', respondedAt: new Date() })
      .where(eq(issuerEvents.id, mine.eventId));

    await register()(request({ kind: 'disconformity', reason: 'Mercadería dañada' }));
    expect(await events()).toHaveLength(2);
  });

  it('answers a concurrent pair of the same event with one stored event and one refusal', async () => {
    const outcomes = await Promise.allSettled([
      register()(
        request({
          kind: 'unawareness',
          reason: 'No la solicité',
          receivedAt: '2026-10-02T09:00:00',
        }),
      ),
      register()(
        request({
          kind: 'unawareness',
          reason: 'No la solicité',
          receivedAt: '2026-10-02T09:00:00',
        }),
      ),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });
});
