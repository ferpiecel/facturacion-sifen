import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPgliteDatabase,
  documents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import {
  createAcceptCreditNote,
  createAcceptDebitNote,
  type AcceptCreditNoteInput,
} from '../application/accept-credit-note.js';
import { InvoiceValidationError } from '../application/accept-invoice.js';
import { parseCdc } from '../domain/cdc.js';
import {
  acceptInvoiceWithStatus,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';

const now = () => new Date('2026-03-06T01:30:00Z');

/** Spec: HU-E7-02. Acceptance of an NDE against a real (pglite) database. */
describe('AcceptDebitNote with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let feCdc: string;
  let keySeq = 0;

  const unitOfWork = () => createDrizzleAcceptanceUnitOfWork(handle.db);
  const note = (
    unitPrice: number,
    type: 'NCE' | 'NDE',
    associatedCdc = feCdc,
  ): AcceptCreditNoteInput => {
    const draft = {
      associatedCdc,
      reasonCode: 3,
      items: [{ quantity: 1, unitPrice, vatRate: 10 as const }],
      roundingPyg: 0,
    };
    return {
      tenantId,
      actor: { type: 'api_key', id: 'key-1' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: { type, ...draft },
      idempotencyKey: `note-${String(++keySeq)}`,
    };
  };
  const rows = () =>
    withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents));

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }])
      .returning();
    tenantId = a.id;
    await seedIssuer(handle.db, tenantId);
    feCdc = (await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-1')).cdc;
  });

  afterEach(async () => {
    await handle.close();
  });

  it('stores an NDE with type 06 and its own sequence, above the FE total', async () => {
    const { documentId, cdc } = await createAcceptDebitNote({ unitOfWork: unitOfWork(), now })(
      note(2_500_000, 'NDE'),
    );

    expect(parseCdc(cdc)).toMatchObject({ documentType: '06', documentNumber: '0000001' });
    const row = (await rows()).find((r) => r.id === documentId);
    expect(row).toMatchObject({
      documentType: 6,
      number: 1,
      status: 'accepted',
      associatedCdc: feCdc,
      receiverRuc: '80069563-1',
    });
    expect(row?.totalAmount).toBe('2500000.00000000');
  });

  it('does not count a debit against the credits of the FE (2417 names credit notes)', async () => {
    const debit = createAcceptDebitNote({ unitOfWork: unitOfWork(), now });
    const credit = createAcceptCreditNote({ unitOfWork: unitOfWork(), now });
    await debit(note(900_000, 'NDE'));

    await expect(credit(note(1_000_000, 'NCE'))).resolves.toMatchObject({
      cdc: expect.stringMatching(/^05/) as string,
    });
  });

  it('refuses an unknown FE before burning a number', async () => {
    const debit = createAcceptDebitNote({ unitOfWork: unitOfWork(), now });
    const unknown = `01${'9'.repeat(42)}`;

    await expect(debit(note(1000, 'NDE', unknown))).rejects.toBeInstanceOf(InvoiceValidationError);
    const { cdc } = await debit(note(1000, 'NDE'));
    expect(parseCdc(cdc).documentNumber).toBe('0000001');
    expect((await rows()).filter((r) => r.documentType === 6)).toHaveLength(1);
  });
});
