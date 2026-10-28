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
  ReceiverCorrectionRefusedError,
  ReceiverEventNotFoundError,
  createCorrectReceiverEvent,
} from '../application/correct-receiver-event.js';
import { createRegisterReceiverEvent } from '../application/register-receiver-event.js';
import { createDrizzleReceiverEventUnitOfWork } from './drizzle-receiver-event-unit-of-work.js';
import { createDrizzleCorrectionUnitOfWork } from './drizzle-correction-unit-of-work.js';

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
const NOW = new Date('2026-10-20T12:00:00Z');

/** Spec: HU-E9-02. The correction command against a real (pglite) database. */
describe('CorrectReceiverEvent with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let keySeq = 0;
  const register = () =>
    createRegisterReceiverEvent({
      unitOfWork: createDrizzleReceiverEventUnitOfWork(handle.db),
      now: () => NOW,
    });
  const correctWith = () =>
    createCorrectReceiverEvent({
      unitOfWork: createDrizzleCorrectionUnitOfWork(handle.db),
      now: () => NOW,
    });
  const correction = (eventId: string, tenant = tenantId) =>
    correctWith()({
      tenantId: tenant,
      actor: { type: 'api_key', id: 'key-1' },
      eventId,
      body: {
        kind: 'disconformity',
        cdc: CDC,
        issuedAt: '2026-10-01T10:00:00',
        reason: 'Mercadería dañada al recibirla',
        correctionReason: 'Se registró conformidad por error',
      },
      idempotencyKey: `corr-${String(++keySeq)}`,
    });
  const approvedConformity = async (): Promise<string> => {
    const { eventId } = await register()({
      tenantId,
      actor: { type: 'api_key', id: 'key-1' },
      body: {
        kind: 'conformity',
        conformityType: 'total',
        cdc: CDC,
        issuedAt: '2026-10-01T10:00:00',
      },
      idempotencyKey: `recv-${String(++keySeq)}`,
    });
    await handle.db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: '<g/>', signedAt: new Date() })
      .where(eq(issuerEvents.id, eventId));
    await handle.db
      .update(issuerEvents)
      .set({ status: 'sending', batchDId: 1n, sendAttemptedAt: new Date() })
      .where(eq(issuerEvents.id, eventId));
    await handle.db
      .update(issuerEvents)
      .set({
        status: 'approved',
        responseCode: '0260',
        respondedAt: new Date('2026-10-18T12:00:00Z'),
      })
      .where(eq(issuerEvents.id, eventId));
    return eventId;
  };

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

  it('stores the replacement linked to the approved original, with its justification, and audits it', async () => {
    const original = await approvedConformity();

    const result = await correction(original);

    const [row] = await handle.db
      .select()
      .from(issuerEvents)
      .where(eq(issuerEvents.id, result.eventId));
    expect(row).toMatchObject({
      kind: 'disconformity',
      targetCdc: CDC,
      status: 'pending',
      correctsEventId: original,
      correctionReason: 'Se registró conformidad por error',
      reason: 'Mercadería dañada al recibirla',
    });
    const audit = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'receiver_event.corrected')),
    );
    expect(audit).toHaveLength(1);
  });

  it('refuses a second correction of the same event and a correction that SIFEN has not approved', async () => {
    const original = await approvedConformity();
    const first = await correction(original);

    await expect(correction(original)).rejects.toBeInstanceOf(ReceiverCorrectionRefusedError);
    await expect(correction(first.eventId)).rejects.toMatchObject({
      refusal: { rule: 'correction-original-not-approved' },
    });
  });

  it('does not correct an event that SIFEN has not approved', async () => {
    const { eventId } = await register()({
      tenantId,
      actor: { type: 'api_key', id: 'key-1' },
      body: {
        kind: 'conformity',
        conformityType: 'total',
        cdc: CDC,
        issuedAt: '2026-10-01T10:00:00',
      },
      idempotencyKey: 'recv-pending',
    });

    await expect(correction(eventId)).rejects.toMatchObject({
      refusal: { rule: 'correction-original-not-approved' },
    });
  });

  it('answers not found for an unknown event and for one of another tenant', async () => {
    const original = await approvedConformity();

    await expect(correction(original, otherTenantId)).rejects.toBeInstanceOf(
      ReceiverEventNotFoundError,
    );
    await expect(correction('99999999-9999-9999-9999-999999999999')).rejects.toBeInstanceOf(
      ReceiverEventNotFoundError,
    );
  });

  it('refuses a correction when a later conclusive event of the CDC stands in its place', async () => {
    const original = await approvedConformity();
    await handle.db.insert(issuerEvents).values({
      tenantId,
      environment: 'test',
      kind: 'unawareness',
      eventId: 900n,
      targetCdc: CDC,
      receiverData: { issuedAt: '2026-10-01T10:00:00' },
      reason: 'No lo conozco',
    });

    await expect(correction(original)).rejects.toMatchObject({
      refusal: { rule: 'correction-original-superseded' },
    });
  });
});
