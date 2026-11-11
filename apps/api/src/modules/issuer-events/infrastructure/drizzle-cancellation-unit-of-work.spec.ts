import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  documents,
  createPgliteDatabase,
  issuerEvents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import {
  acceptInvoiceWithStatus,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import { createAcceptCreditNote } from '../../emission/application/accept-credit-note.js';
import { createDrizzleAcceptanceUnitOfWork } from '../../emission/infrastructure/drizzle-acceptance-unit-of-work.js';
import { createCancelDocument, DocumentNotFoundError } from '../application/cancel-document.js';
import { createDrizzleCancellationUnitOfWork } from './drizzle-cancellation-unit-of-work.js';

/** Spec: HU-E8-02. The cancellation command against a real (pglite) database. */
describe('CancelDocument with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let feId: string;
  let feCdc: string;
  let keySeq = 0;
  // approved_at is stamped with the database clock when the fixture approves the FE.
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

  const cancel = () =>
    createCancelDocument({
      unitOfWork: createDrizzleCancellationUnitOfWork(handle.db),
      now: () => hoursFromNow(1),
    });
  const request = (documentId = feId, overrides = {}) => ({
    tenantId,
    actor: { type: 'api_key', id: 'key-1' } as const,
    documentId,
    reason: 'Error en el importe',
    idempotencyKey: `cancel-${String(++keySeq)}`,
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
    const fe = await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-1');
    feId = fe.documentId;
    feCdc = fe.cdc;
  });

  afterEach(async () => {
    await handle.close();
  });

  it('stores a pending cancellation with the next event id and audits it', async () => {
    const result = await cancel()(request());
    expect(result).toMatchObject({ documentId: feId, status: 'pending' });
    const [event] = await events();
    expect(event).toMatchObject({
      id: result.eventId,
      kind: 'cancellation',
      documentId: feId,
      status: 'pending',
      reason: 'Error en el importe',
      environment: 'test',
    });
    expect(event.eventId).toBeGreaterThan(0n);
    expect(event.idempotencyKey).toMatch(/^cancel-/);
    const audits = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'document.cancellation_requested')),
    );
    expect(audits).toHaveLength(1);
  });

  it('is idempotent by key and stores one event', async () => {
    const first = request();
    const a = await cancel()(first);
    const b = await cancel()(first);
    expect(b).toEqual(a);
    expect(await events()).toHaveLength(1);
  });

  it('refuses a second request with another key while one is open, burning no event id', async () => {
    await cancel()(request());
    await expect(cancel()(request())).rejects.toMatchObject({
      name: 'CancellationAlreadyRequestedError',
    });
    expect(await events()).toHaveLength(1);
  });

  it('finds no document of another tenant', async () => {
    await expect(cancel()(request(feId, { tenantId: otherTenantId }))).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
    expect(await events(otherTenantId)).toHaveLength(0);
  });

  it('refuses a document that SIFEN does not hold as approved', async () => {
    const draft = await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-2', 'rejected');
    await expect(cancel()(request(draft.documentId))).rejects.toMatchObject({
      refusal: { rule: 'document-not-approved' },
    });
    expect(await events()).toHaveLength(0);
  });

  it('refuses outside the window using the stored approval instant', async () => {
    const late = createCancelDocument({
      unitOfWork: createDrizzleCancellationUnitOfWork(handle.db),
      now: () => hoursFromNow(50),
    });
    await expect(late(request())).rejects.toMatchObject({
      refusal: { rule: 'cancel-window-expired', sifenCode: '4009' },
    });
  });

  it('refuses a document with a live credit note and lists its CDC', async () => {
    const draft = {
      associatedCdc: feCdc,
      reasonCode: 2,
      items: [{ quantity: 1, unitPrice: 1000, vatRate: 10 as const }],
      roundingPyg: 0,
    };
    const nce = await createAcceptCreditNote({
      unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
      now: () => new Date('2026-03-06T01:30:00Z'),
    })({
      tenantId,
      actor: { type: 'api_key', id: 'k' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: { type: 'NCE', ...draft },
      idempotencyKey: 'nce-1',
    });
    await expect(cancel()(request())).rejects.toMatchObject({
      refusal: { rule: 'has-live-associated-documents', associatedCdcs: [nce.cdc] },
    });
  });

  describe('credit note statuses against the live-associated rule', () => {
    const acceptNce = async () => {
      const draft = {
        associatedCdc: feCdc,
        reasonCode: 2,
        items: [{ quantity: 1, unitPrice: 1000, vatRate: 10 as const }],
        roundingPyg: 0,
      };
      return createAcceptCreditNote({
        unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
        now: () => new Date('2026-03-06T01:30:00Z'),
      })({
        tenantId,
        actor: { type: 'api_key', id: 'k' },
        establishmentCode: '001',
        expeditionPointCode: '002',
        draft,
        payload: { type: 'NCE', ...draft },
        idempotencyKey: 'nce-status',
      });
    };
    const PATHS: Record<string, string[]> = {
      accepted: [],
      signed: ['signed'],
      queued: ['signed', 'queued'],
      submitted: ['signed', 'submitted'],
      approved: ['signed', 'submitted', 'approved'],
      approved_with_observations: ['signed', 'submitted', 'approved_with_observations'],
      rejected: ['signed', 'submitted', 'rejected'],
      corrected: ['signed', 'submitted', 'rejected', 'corrected'],
    };
    const setStatus = async (id: string, status: string) => {
      for (const step of PATHS[status]) {
        await handle.db.update(documents).set({ status: step }).where(eq(documents.id, id));
      }
    };

    it.each(['rejected', 'corrected'] as const)('lets a %s credit note go', async (status) => {
      const nce = await acceptNce();
      await setStatus(nce.documentId, status);
      await expect(cancel()(request())).resolves.toBeDefined();
    });

    it.each([
      'accepted',
      'signed',
      'queued',
      'submitted',
      'approved',
      'approved_with_observations',
    ] as const)('blocks on a %s credit note', async (status) => {
      const nce = await acceptNce();
      await setStatus(nce.documentId, status);
      await expect(cancel()(request())).rejects.toMatchObject({
        refusal: { rule: 'has-live-associated-documents', associatedCdcs: [nce.cdc] },
      });
    });
  });
});
