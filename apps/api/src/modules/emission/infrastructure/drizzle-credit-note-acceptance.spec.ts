import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  documents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import {
  createAcceptCreditNote,
  type AcceptCreditNoteInput,
} from '../application/accept-credit-note.js';
import { InvoiceValidationError } from '../application/accept-invoice.js';
import { parseCdc } from '../domain/cdc.js';
import {
  acceptInvoiceWithStatus,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';

const ITEM = { quantity: 1, unitPrice: 400_000, vatRate: 10 as const };

/** Spec: HU-E7-01 T6 (ADR-0019). Acceptance of an NCE against a real (pglite) database. */
describe('AcceptCreditNote with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let keySeq = 0;
  let feCdc: string;
  let feId: string;

  const unitOfWork = () => createDrizzleAcceptanceUnitOfWork(handle.db);
  const acceptCredit = () =>
    createAcceptCreditNote({
      unitOfWork: unitOfWork(),
      now: () => new Date('2026-03-06T01:30:00Z'),
    });

  const acceptedInvoice = (owner: string, status = 'approved') =>
    acceptInvoiceWithStatus(handle.db, owner, `fe-${String(++keySeq)}`, status);

  const credit = (overrides: Partial<AcceptCreditNoteInput> = {}): AcceptCreditNoteInput => {
    const draft = { associatedCdc: feCdc, reasonCode: 2, items: [ITEM], roundingPyg: 0 };
    return {
      tenantId,
      actor: { type: 'api_key', id: 'key-1' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: { type: 'NCE', ...draft },
      idempotencyKey: `nce-${String(++keySeq)}`,
      ...overrides,
    };
  };

  const rows = () =>
    withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents));
  const rulesOf = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvoiceValidationError);
    return (error as InvoiceValidationError).errors.map((e) => e.rule);
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
    const fe = await acceptedInvoice(tenantId);
    feCdc = fe.cdc;
    feId = fe.documentId;
  });

  afterEach(async () => {
    await handle.close();
  });

  it('stores an NCE with type 05, its own numbering, the association and the FE receiver', async () => {
    const { documentId, cdc } = await acceptCredit()(credit());

    expect(parseCdc(cdc)).toMatchObject({ documentType: '05', documentNumber: '0000001' });
    const row = (await rows()).find((r) => r.id === documentId);
    expect(row).toMatchObject({
      documentType: 5,
      number: 1,
      status: 'accepted',
      associatedCdc: feCdc,
      receiverRuc: '80069563-1',
      currency: 'PYG',
    });
    expect(row?.totalAmount).toBe('400000.00000000');
    // The FE keeps its own sequence and no association.
    expect((await rows()).find((r) => r.id === feId)).toMatchObject({
      documentType: 1,
      number: 1,
      associatedCdc: null,
    });
    const audit = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, documentId)),
    );
    expect(audit[0]).toMatchObject({ action: 'document.accepted' });
  });

  it('answers a domain error, not a 500, when the FE payload cannot be read any more', async () => {
    const [fe] = await handle.db.select().from(documents).where(eq(documents.id, feId));
    const [broken] = await handle.db
      .insert(documents)
      .values({
        ...fe,
        id: undefined,
        cdc: `01${'2'.repeat(42)}`,
        number: 2,
        idempotencyKey: 'fe-broken',
        payload: { legacy: true },
        status: 'approved',
      })
      .returning();
    const draft = { associatedCdc: broken.cdc, reasonCode: 2, items: [ITEM], roundingPyg: 0 };
    expect(await rulesOf(acceptCredit()(credit({ draft })))).toEqual([
      'associated-document-unreadable',
    ]);
  });

  describe('refusals burn no number', () => {
    const nextNumberIsOne = async () => {
      const { cdc } = await acceptCredit()(credit());
      expect(parseCdc(cdc).documentNumber).toBe('0000001');
    };

    it('rejects a credit over the FE total with 2417 and keeps the numbering gapless', async () => {
      const big = { ...ITEM, unitPrice: 1_000_050 };
      const draft = { associatedCdc: feCdc, reasonCode: 2, items: [big], roundingPyg: 0 };
      expect(await rulesOf(acceptCredit()(credit({ draft })))).toEqual([
        'credit-note-sum-exceeds-invoice',
      ]);
      await nextNumberIsOne();
    });
  });
});
