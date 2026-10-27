import { describe, expect, it, vi } from 'vitest';
import { requestHash } from '../domain/request-hash.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import {
  CertificateExpiringError,
  IdempotencyKeyReusedError,
  InvoiceValidationError,
  IssuerNotConfiguredError,
} from './accept-invoice.js';
import {
  CorrectionRequiresReissueError,
  CorrectionTypeChangedError,
  DocumentNotCorrectableError,
  DocumentNotFoundError,
  createCorrectDocument,
  type CorrectDocumentInput,
} from './correct-document.js';
import type {
  CorrectableDocument,
  CorrectionUnit,
  StoredCorrection,
} from './ports/correction-unit-of-work.port.js';

const CDC = '01800695631001001000000112026010111234567891';
const FE_CDC = '01800695631001002000000112026010111234567891';
const DRAFT: InvoiceDraft = {
  receiver: {
    kind: 'named',
    isPublicEntity: false,
    ruc: '80069563-1',
    address: { street: 'Avda Prueba', houseNumber: '100', cityCode: 3344 },
  } as InvoiceDraft['receiver'],
  operationType: 'B2B',
  items: [{ quantity: 2, unitPrice: 55_000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};
const PAYLOAD = { type: 'FE', establishment: '001', expeditionPoint: '001' };
const INPUT: CorrectDocumentInput = {
  tenantId: 't1',
  actor: { type: 'api_key', id: 'k' },
  documentId: 'doc-1',
  establishmentCode: '001',
  expeditionPointCode: '001',
  correction: { type: 'FE', draft: DRAFT, receiverRuc: '80069563-1' },
  payload: PAYLOAD,
  idempotencyKey: 'key-1',
};
const REJECTED: CorrectableDocument = {
  id: 'doc-1',
  cdc: CDC,
  documentType: 1,
  status: 'rejected',
  establishmentCode: '001',
  expeditionPointCode: '001',
  associatedCdc: null,
  payload: { old: true },
  sifenMessages: [{ code: '1000' }],
};

function setup(
  options: {
    document?: CorrectableDocument | null;
    stored?: StoredCorrection | null;
    /** The key is stored only once the document lock was taken (a concurrent retry committed). */
    storedAfterLock?: boolean;
    noIssuer?: boolean;
  } = {},
  certificateNotAfter?: Date,
) {
  let lookups = 0;
  const rewriteDocument = vi.fn(() => Promise.resolve());
  const recordAudit = vi.fn(() => Promise.resolve());
  const sumCreditNotes = vi.fn(() => Promise.resolve('0'));
  const unit: CorrectionUnit = {
    findCorrectionByKey: () =>
      Promise.resolve(lookups++ === 0 && options.storedAfterLock ? null : (options.stored ?? null)),
    lockDocument: () =>
      Promise.resolve(options.document === undefined ? REJECTED : options.document),
    resolveIssuer: () =>
      Promise.resolve(
        options.noIssuer
          ? null
          : {
              environment: 'test' as const,
              rucBase: '80069563',
              rucDv: 1,
              taxpayerType: 2 as const,
              timbradoId: 'tim',
              establishmentId: 'est',
              expeditionPointId: 'pt',
              certificateNotAfter,
            },
      ),
    findAssociatedInvoice: () =>
      Promise.resolve({
        receiver: DRAFT.receiver,
        operationType: 'B2B' as const,
        location: {},
        status: 'approved',
        currency: 'PYG',
        totalAmount: '1000000',
        receiverRuc: '80069563-1',
      }),
    sumCreditNotes,
    rewriteDocument,
    recordAudit,
  };
  const correct = createCorrectDocument({
    unitOfWork: { run: (_tenant, work) => work(unit) },
    now: () => new Date('2026-03-06T15:00:00Z'),
  });
  return { correct, rewriteDocument, recordAudit, sumCreditNotes };
}

/** Spec: HU-E8-01, ADR-0021 (same-CDC path). */
describe('correctDocument', () => {
  it('rewrites the rejected row with the new body, keeping its CDC', async () => {
    const { correct, rewriteDocument, recordAudit } = setup();
    await expect(correct(INPUT)).resolves.toEqual({ documentId: 'doc-1', cdc: CDC });
    expect(rewriteDocument).toHaveBeenCalledWith({
      document: REJECTED,
      payload: PAYLOAD,
      receiverRuc: '80069563-1',
      totalAmount: '110000',
      idempotencyKey: 'key-1',
      requestHash: requestHash({ documentId: 'doc-1', payload: PAYLOAD }),
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.corrected',
        entity: { type: 'document', id: 'doc-1' },
        after: { cdc: CDC, status: 'accepted', correction: 'same_cdc' },
      }),
    );
  });

  it('replays an earlier correction with the same key and body', async () => {
    const stored = {
      documentId: 'doc-1',
      cdc: CDC,
      requestHash: requestHash({ documentId: 'doc-1', payload: PAYLOAD }),
    };
    const { correct, rewriteDocument } = setup({
      stored,
      document: { ...REJECTED, status: 'accepted' },
    });
    await expect(correct(INPUT)).resolves.toEqual({ documentId: 'doc-1', cdc: CDC });
    expect(rewriteDocument).not.toHaveBeenCalled();
  });

  it('replays a concurrent retry that committed while this one waited for the lock', async () => {
    const stored = {
      documentId: 'doc-1',
      cdc: CDC,
      requestHash: requestHash({ documentId: 'doc-1', payload: PAYLOAD }),
    };
    const { correct, rewriteDocument } = setup({
      stored,
      storedAfterLock: true,
      document: { ...REJECTED, status: 'accepted' },
    });
    await expect(correct(INPUT)).resolves.toEqual({ documentId: 'doc-1', cdc: CDC });
    expect(rewriteDocument).not.toHaveBeenCalled();
  });

  it('refuses a key already used with another body', async () => {
    const { correct } = setup({ stored: { documentId: 'doc-1', cdc: CDC, requestHash: 'x' } });
    await expect(correct(INPUT)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('reports a missing document', async () => {
    const { correct } = setup({ document: null });
    await expect(correct(INPUT)).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it('refuses a document that is not rejected', async () => {
    const { correct, rewriteDocument } = setup({ document: { ...REJECTED, status: 'approved' } });
    await expect(correct(INPUT)).rejects.toEqual(new DocumentNotCorrectableError('approved'));
    expect(rewriteDocument).not.toHaveBeenCalled();
  });

  it('refuses to change the document type', async () => {
    const { correct } = setup({ document: { ...REJECTED, documentType: 4 } });
    await expect(correct(INPUT)).rejects.toBeInstanceOf(CorrectionTypeChangedError);
  });

  it('asks for a reissue when the CDC would change (slice C handles it)', async () => {
    const { correct, rewriteDocument } = setup();
    const input = { ...INPUT, establishmentCode: '002' };
    await expect(correct(input)).rejects.toBeInstanceOf(CorrectionRequiresReissueError);
    expect(rewriteDocument).not.toHaveBeenCalled();
  });

  it('validates the corrected draft before rewriting', async () => {
    const { correct, rewriteDocument } = setup();
    const draft = { ...DRAFT, items: [] };
    const input = { ...INPUT, correction: { type: 'FE' as const, draft, receiverRuc: null } };
    await expect(correct(input)).rejects.toBeInstanceOf(InvoiceValidationError);
    expect(rewriteDocument).not.toHaveBeenCalled();
  });

  it('refuses when the point is not configured', async () => {
    const { correct } = setup({ noIssuer: true });
    await expect(correct(INPUT)).rejects.toBeInstanceOf(IssuerNotConfiguredError);
  });

  it('refuses while the certificate is about to expire', async () => {
    const { correct } = setup({}, new Date('2026-03-07T00:00:00Z'));
    await expect(correct(INPUT)).rejects.toBeInstanceOf(CertificateExpiringError);
  });

  it('excludes the credit note own amount from the 2417 sum', async () => {
    const note = { ...REJECTED, documentType: 5, associatedCdc: FE_CDC };
    const { correct, sumCreditNotes, rewriteDocument } = setup({ document: note });
    const draft = {
      associatedCdc: FE_CDC,
      reasonCode: 2,
      items: [{ quantity: 1, unitPrice: 600_000, vatRate: 10 as const }],
      roundingPyg: 0,
    };
    await correct({ ...INPUT, correction: { type: 'NCE', draft } });
    expect(sumCreditNotes).toHaveBeenCalledWith(FE_CDC, 'test', CDC);
    expect(rewriteDocument).toHaveBeenCalledWith(
      expect.objectContaining({ receiverRuc: '80069563-1', totalAmount: '600000' }),
    );
  });
});
