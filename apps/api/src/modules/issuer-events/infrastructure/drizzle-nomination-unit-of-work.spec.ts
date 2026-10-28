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
import {
  FE_BODY,
  acceptInvoiceWithStatus,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import { DocumentNotFoundError } from '../application/cancel-document.js';
import { createNominateDocument } from '../application/nominate-document.js';
import type { NominationReceiver } from '../domain/nominate-rules.js';
import { createDrizzleNominationUnitOfWork } from './drizzle-nomination-unit-of-work.js';

const UNNAMED_FE = {
  ...FE_BODY,
  operationType: 'B2C',
  receiver: { kind: 'unnamed' },
};
const RECEIVER: NominationReceiver = {
  kind: 'non-taxpayer',
  documentType: 1,
  documentNumber: '1234567',
  name: 'Juan Perez',
  country: 'PRY',
  operationType: 'B2C',
};

/** Spec: HU-E8-05. The nomination command against a real (pglite) database. */
describe('NominateDocument with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let feId: string;
  let keySeq = 0;

  const nominate = () =>
    createNominateDocument({ unitOfWork: createDrizzleNominationUnitOfWork(handle.db) });
  const request = (documentId = feId, overrides = {}) => ({
    tenantId,
    actor: { type: 'api_key', id: 'key-1' } as const,
    documentId,
    reason: 'El receptor pidio nombrar la factura',
    receiver: RECEIVER,
    idempotencyKey: `nominate-${String(++keySeq)}`,
    ...overrides,
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
    feId = (await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-1', 'approved', UNNAMED_FE))
      .documentId;
  });

  afterEach(async () => {
    await handle.close();
  });

  it('stores a pending nomination with the receiver and audits it', async () => {
    const result = await nominate()(request());
    expect(result).toMatchObject({ documentId: feId, status: 'pending' });
    const [event] = await events();
    expect(event).toMatchObject({
      id: result.eventId,
      kind: 'nomination',
      documentId: feId,
      status: 'pending',
      nomination: RECEIVER,
    });
    const audits = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'document.nomination_requested')),
    );
    expect(audits).toHaveLength(1);
  });

  it('is idempotent by key and stores one event', async () => {
    const first = request();
    const a = await nominate()(first);
    expect(await nominate()(first)).toEqual(a);
    expect(await events()).toHaveLength(1);
  });

  it('refuses a second nomination with another key (4453), burning no event id', async () => {
    await nominate()(request());
    await expect(nominate()(request())).rejects.toMatchObject({
      name: 'NominationAlreadyRequestedError',
    });
    expect(await events()).toHaveLength(1);
  });

  it('refuses an FE whose receiver is named (4469)', async () => {
    const named = await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-2');
    await expect(nominate()(request(named.documentId))).rejects.toMatchObject({
      refusal: { rule: 'nominate-receiver-named' },
    });
    expect(await events()).toHaveLength(0);
  });

  it('refuses an FE that SIFEN has not approved (4002)', async () => {
    const signed = await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-3', 'signed', UNNAMED_FE);
    await expect(nominate()(request(signed.documentId))).rejects.toMatchObject({
      refusal: { rule: 'document-not-approved' },
    });
  });

  it('finds no document of another tenant', async () => {
    await expect(nominate()(request(feId, { tenantId: otherTenantId }))).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
    expect(await events(otherTenantId)).toHaveLength(0);
  });
});
