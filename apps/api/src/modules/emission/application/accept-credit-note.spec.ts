import { describe, expect, it, vi } from 'vitest';
import { requestHash } from '../domain/request-hash.js';
import { createAcceptCreditNote, type AcceptCreditNoteInput } from './accept-credit-note.js';
import { CertificateExpiringError, IdempotencyKeyReusedError } from './accept-invoice.js';
import type {
  AcceptanceUnit,
  AssociatedInvoice,
  StoredAcceptance,
} from './ports/acceptance-unit-of-work.port.js';

const FE_CDC = '01800695631001002000000112026010111234567891';
const draft = {
  associatedCdc: FE_CDC,
  reasonCode: 2,
  items: [{ quantity: 1, unitPrice: 600_000, vatRate: 10 as const }],
  roundingPyg: 0,
};
const INPUT: AcceptCreditNoteInput = {
  tenantId: 't1',
  actor: { type: 'api_key', id: 'k' },
  establishmentCode: '001',
  expeditionPointCode: '002',
  draft,
  payload: { type: 'NCE', ...draft },
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

/** Spec: HU-E7-01 (ADR-0019 D5). The idempotency key is read again once the FE row is locked. */
describe('acceptCreditNote idempotency under concurrency', () => {
  function run(
    keyLookups: (StoredAcceptance | null)[],
    credited = '600000',
    certificateNotAfter?: Date,
  ) {
    const insertDocument = vi.fn(() => Promise.resolve({ id: 'new' }));
    const nextNumber = vi.fn(() => Promise.resolve({ series: null, number: 1 }));
    const lookups = [...keyLookups];
    const unit: AcceptanceUnit = {
      findByIdempotencyKey: () => Promise.resolve(lookups.shift() ?? null),
      resolveIssuer: () =>
        Promise.resolve({
          environment: 'test' as const,
          rucBase: '80069563',
          rucDv: 1,
          taxpayerType: 2 as const,
          timbradoId: 'tim',
          establishmentId: 'est',
          expeditionPointId: 'pt',
          certificateNotAfter,
        }),
      findAssociatedInvoice: () => Promise.resolve(INVOICE),
      sumCreditNotes: () => Promise.resolve(credited),
      nextNumber,
      insertDocument,
      recordAudit: () => Promise.resolve(),
    };
    const accept = createAcceptCreditNote({
      unitOfWork: { run: (_tenant, work) => work(unit) },
      now: () => new Date('2026-03-06T01:30:00Z'),
    });
    return { accept, insertDocument, nextNumber };
  }

  it('replays the document a parallel request with the same key committed while this one waited for the lock', async () => {
    const stored = {
      documentId: 'doc-1',
      cdc: `05${'1'.repeat(42)}`,
      requestHash: requestHash(INPUT.payload),
    };
    const { accept, insertDocument, nextNumber } = run([null, stored]);

    await expect(accept(INPUT)).resolves.toEqual({ documentId: 'doc-1', cdc: stored.cdc });
    expect(nextNumber).not.toHaveBeenCalled();
    expect(insertDocument).not.toHaveBeenCalled();
  });

  it('refuses the same key with another body found after the lock', async () => {
    const stored = { documentId: 'doc-1', cdc: `05${'1'.repeat(42)}`, requestHash: 'f'.repeat(64) };
    const { accept } = run([null, stored]);

    await expect(accept(INPUT)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  /** Spec: HU-E3-03. */
  it('refuses before numbering when the certificate expires within a day', async () => {
    const { accept, nextNumber } = run([null], '0', new Date('2026-03-07T01:00:00Z'));

    await expect(accept(INPUT)).rejects.toBeInstanceOf(CertificateExpiringError);
    expect(nextNumber).not.toHaveBeenCalled();
  });
});
