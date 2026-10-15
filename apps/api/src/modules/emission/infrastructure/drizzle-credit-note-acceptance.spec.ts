import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { createAcceptInvoice } from '../application/accept-invoice.js';
import {
  createAcceptCreditNote,
  type AcceptCreditNoteInput,
} from '../application/accept-credit-note.js';
import { InvoiceValidationError } from '../application/accept-invoice.js';
import { parseCdc } from '../domain/cdc.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';
import { parseCreateDocument, toAcceptInvoiceInput } from './http/create-document.request.js';

const FE_BODY = {
  establishment: '001',
  expeditionPoint: '002',
  operationType: 'B2B',
  receiver: { kind: 'named', ruc: '80069563-1', name: 'Cliente SA' },
  items: [
    {
      code: 'A-001',
      description: 'Servicio',
      unitCode: 77,
      quantity: 1,
      unitPrice: 1_000_000,
      vatRate: 10,
    },
  ],
};
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

  async function seedTenant(id: string) {
    await handle.db.insert(tenantFiscalProfiles).values({
      tenantId: id,
      rucBase: '80069563',
      rucDv: 1,
      legalName: 'Empresa SA',
      taxpayerType: 'persona_juridica',
    });
    const [est] = await handle.db
      .insert(tenantEstablishments)
      .values({
        tenantId: id,
        code: '001',
        address: 'Av. Mariscal Lopez 123',
        houseNumber: '123',
        departmentCode: '11',
        cityCode: '3432',
        cityDescription: 'Asuncion',
      })
      .returning();
    await handle.db
      .insert(tenantExpeditionPoints)
      .values({ tenantId: id, establishmentId: est.id, code: '002' });
    await handle.db
      .insert(tenantTimbrados)
      .values({ tenantId: id, number: '22222222', validFrom: '2026-01-01' });
  }

  /** The FE goes through the real use case, then SIFEN's answer is simulated by moving its status forward. */
  async function acceptedInvoice(owner: string, status = 'approved') {
    const parsed = parseCreateDocument(FE_BODY);
    if (!parsed.ok) throw new Error('fixture');
    const accepted = await createAcceptInvoice({
      unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
      now: () => new Date('2026-03-05T12:00:00Z'),
    })(
      toAcceptInvoiceInput(parsed.value, {
        tenantId: owner,
        actor: { type: 'api_key', id: 'k' },
        payload: parsed.value,
        idempotencyKey: `fe-${String(++keySeq)}`,
      }),
    );
    for (const step of ['signed', 'submitted', status]) {
      await handle.db
        .update(documents)
        .set({ status: step })
        .where(eq(documents.id, accepted.documentId));
    }
    return accepted;
  }

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
    await seedTenant(tenantId);
    await seedTenant(otherTenantId);
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
