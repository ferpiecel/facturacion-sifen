import { describe, expect, it, vi } from 'vitest';
import { InvoiceValidationError } from './accept-invoice.js';
import { createAcceptDebitNote, type AcceptCreditNoteInput } from './accept-credit-note.js';
import type { AcceptanceUnit, AssociatedInvoice } from './ports/acceptance-unit-of-work.port.js';

const FE_CDC = '01800695631001002000000112026010111234567891';
const draft = {
  associatedCdc: FE_CDC,
  reasonCode: 3,
  items: [{ quantity: 1, unitPrice: 5_000_000, vatRate: 10 as const }],
  roundingPyg: 0,
};
const INPUT: AcceptCreditNoteInput = {
  tenantId: 't1',
  actor: { type: 'api_key', id: 'k' },
  establishmentCode: '001',
  expeditionPointCode: '002',
  draft,
  payload: { type: 'NDE', ...draft },
  idempotencyKey: 'key-1',
};
const INVOICE: AssociatedInvoice = {
  receiver: { kind: 'named', isPublicEntity: false },
  operationType: 'B2B',
  location: {},
  status: 'approved',
  currency: 'PYG',
  totalAmount: '1000000',
  receiverRuc: '80069563-1',
};

/** Spec: HU-E7-02 (ADR-0019 extended to the NDE). An NDE is type 6, own numbering, no 2417 sum. */
describe('acceptDebitNote', () => {
  function run(invoice: AssociatedInvoice | null = INVOICE) {
    const insertDocument = vi.fn(() => Promise.resolve({ id: 'new' }));
    const nextNumber = vi.fn(() => Promise.resolve({ series: null, number: 7 }));
    const sumCreditNotes = vi.fn(() => Promise.resolve('0'));
    const recordAudit = vi.fn(() => Promise.resolve());
    const unit: AcceptanceUnit = {
      findByIdempotencyKey: () => Promise.resolve(null),
      resolveIssuer: () =>
        Promise.resolve({
          environment: 'test' as const,
          rucBase: '80069563',
          rucDv: 1,
          taxpayerType: 2 as const,
          timbradoId: 'tim',
          establishmentId: 'est',
          expeditionPointId: 'pt',
        }),
      findAssociatedInvoice: () => Promise.resolve(invoice),
      sumCreditNotes,
      nextNumber,
      insertDocument,
      recordAudit,
    };
    const accept = createAcceptDebitNote({
      unitOfWork: { run: (_tenant, work) => work(unit) },
      now: () => new Date('2026-03-06T01:30:00Z'),
    });
    return { accept, insertDocument, nextNumber, sumCreditNotes, recordAudit };
  }

  it('takes a type 6 number and stores an NDE CDC associated to the FE, above the FE total', async () => {
    const { accept, insertDocument, nextNumber, sumCreditNotes } = run();

    const accepted = await accept(INPUT);

    expect(nextNumber).toHaveBeenCalledWith(expect.anything(), 6);
    expect(sumCreditNotes).not.toHaveBeenCalled();
    expect(accepted.cdc.startsWith('06')).toBe(true);
    expect(insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 6,
        associatedCdc: FE_CDC,
        receiverRuc: '80069563-1',
        totalAmount: '5000000',
      }),
    );
  });

  it('refuses before numbering when the FE is unknown, with the debit note rules', async () => {
    const { accept, nextNumber } = run(null);

    const error = await accept(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvoiceValidationError);
    expect((error as InvoiceValidationError).errors.map((e) => e.rule)).toEqual([
      'associated-document-not-found',
    ]);
    expect(nextNumber).not.toHaveBeenCalled();
  });
});
