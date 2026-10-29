import { describe, expect, it, vi } from 'vitest';
import { requestHash } from '../domain/request-hash.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import {
  CertificateExpiringError,
  IdempotencyKeyReusedError,
  InvoiceValidationError,
  IssuerNotConfiguredError,
} from './accept-invoice.js';
import { VoidRefusedError } from '../../issuer-events/application/void-numbers.js';
import {
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
  timbradoNumber: '12345678',
  series: '',
  number: 7,
  issuedAt: new Date('2026-03-05T12:00:00Z'),
};
const NEW_DOC = { documentId: 'doc-2', cdc: '01800695631001002000000222026030611234567892' };

function setup(
  options: {
    document?: CorrectableDocument | null;
    stored?: StoredCorrection | null;
    /** The key is stored only once the document lock was taken (a concurrent retry committed). */
    storedAfterLock?: boolean;
    reissued?: { documentId: string; cdc: string } | null;
    noIssuer?: boolean;
    voidError?: Error;
    /** Transactions of one tenant run one at a time, as the document row lock makes them. */
    serialize?: boolean;
    /** A correction another request already claimed (ADR-0021). */
    claim?: { idempotencyKey: string; requestHash: string } | null;
    /** The replacement is not issued until this resolves (a slow acceptance). */
    acceptGate?: Promise<void>;
    /** A document already holds the replacement's derived key (issued by an earlier attempt, not linked yet). */
    replacementIssued?: boolean;
  } = {},
  certificateNotAfter?: Date,
) {
  let lookups = 0;
  let status = options.document?.status ?? 'rejected';
  let claim = options.claim ?? null;
  const rewriteDocument = vi.fn(() => {
    status = 'accepted';
    return Promise.resolve();
  });
  const claimDocument = vi.fn((change: { idempotencyKey: string; requestHash: string }) => {
    claim = { idempotencyKey: change.idempotencyKey, requestHash: change.requestHash };
    return Promise.resolve();
  });
  const releaseClaim = vi.fn(() => {
    claim = null;
    return Promise.resolve();
  });
  const recordAudit = vi.fn(() => Promise.resolve());
  let linked: { documentId: string; cdc: string } | null = null;
  const recordReissue = vi.fn(() => {
    linked = NEW_DOC;
    return Promise.resolve();
  });
  const acceptFe = vi.fn<(input: { idempotencyKey: string }) => Promise<typeof NEW_DOC>>(
    async () => {
      await options.acceptGate;
      return NEW_DOC;
    },
  );
  const voidNumbers = vi.fn(() =>
    options.voidError
      ? Promise.reject(options.voidError)
      : Promise.resolve({ eventId: 'ev', status: 'pending' as const }),
  );
  const sumCreditNotes = vi.fn(() => Promise.resolve('0'));
  const unit: CorrectionUnit = {
    findCorrectionByKey: () =>
      Promise.resolve(lookups++ === 0 && options.storedAfterLock ? null : (options.stored ?? null)),
    lockDocument: () => {
      const document = options.document === undefined ? REJECTED : options.document;
      return Promise.resolve(document && { ...document, status });
    },
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
    findByIdempotencyKey: () =>
      Promise.resolve(options.replacementIssued ? { ...NEW_DOC, requestHash: 'h'.repeat(64) } : null),
    rewriteDocument,
    recordAudit,
    findReissue: () => Promise.resolve(linked ?? options.reissued ?? null),
    recordReissue,
    findClaim: () => Promise.resolve(claim),
    claimDocument,
    releaseClaim,
  };
  let tail: Promise<unknown> = Promise.resolve();
  const correct = createCorrectDocument({
    unitOfWork: {
      run: (_tenant, work) => {
        if (!options.serialize) return work(unit);
        const result = tail.then(() => work(unit));
        tail = result.catch(() => undefined);
        return result;
      },
    },
    accept: { FE: acceptFe, AFE: vi.fn(), NCE: vi.fn(), NDE: vi.fn() },
    voidNumbers,
    now: () => new Date('2026-03-06T15:00:00Z'),
  });
  return {
    correct,
    rewriteDocument,
    recordAudit,
    sumCreditNotes,
    recordReissue,
    acceptFe,
    voidNumbers,
    claimDocument,
    releaseClaim,
  };
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

  describe('reissue', () => {
    const moved = {
      ...INPUT,
      establishmentCode: '002',
      payload: { ...PAYLOAD, establishment: '002' },
    };

    it('issues the corrected body under a new number and voids the old one', async () => {
      const { correct, acceptFe, recordReissue, voidNumbers, rewriteDocument } = setup();
      await expect(correct(moved)).resolves.toEqual(NEW_DOC);
      expect(rewriteDocument).not.toHaveBeenCalled();
      expect(acceptFe).toHaveBeenCalledWith(
        expect.objectContaining({
          establishmentCode: '002',
          payload: moved.payload,
          receiverRuc: '80069563-1',
          idempotencyKey: expect.stringContaining(':reissue') as string,
        }),
      );
      expect(recordReissue).toHaveBeenCalledWith(
        expect.objectContaining({ document: REJECTED, replacementDocumentId: 'doc-2' }),
      );
      expect(voidNumbers).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            timbrado: '12345678',
            establishment: '001',
            expeditionPoint: '001',
            type: 1,
            from: 7,
            to: 7,
          }) as object,
          idempotencyKey: expect.stringContaining(':void') as string,
        }),
      );
    });

    it('resumes a stored reissue: no second document, the void is requested again', async () => {
      const stored = {
        documentId: 'doc-1',
        cdc: CDC,
        requestHash: requestHash({ documentId: 'doc-1', payload: moved.payload }),
        replacement: NEW_DOC,
      };
      const { correct, acceptFe, recordReissue, voidNumbers } = setup({ stored });
      await expect(correct(moved)).resolves.toEqual(NEW_DOC);
      expect(acceptFe).not.toHaveBeenCalled();
      expect(recordReissue).not.toHaveBeenCalled();
      expect(voidNumbers).toHaveBeenCalledOnce();
    });

    it('refuses a document that was already reissued under another key', async () => {
      const { correct, acceptFe } = setup({ reissued: NEW_DOC });
      await expect(correct(moved)).rejects.toEqual(new DocumentNotCorrectableError('reissued'));
      expect(acceptFe).not.toHaveBeenCalled();
    });

    it('a concurrent reissue with another key is a 409 before it issues anything', async () => {
      const { correct, acceptFe, recordReissue } = setup({ serialize: true });
      const other = { ...moved, idempotencyKey: 'key-2' };
      const results = await Promise.allSettled([correct(moved), correct(other)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect((results[1] as PromiseRejectedResult).reason).toEqual(
        new DocumentNotCorrectableError('correction_in_progress'),
      );
      expect(acceptFe).toHaveBeenCalledOnce();
      expect(recordReissue).toHaveBeenCalledOnce();
    });

    describe('one in-flight correction per document', () => {
      const rewrite = { ...INPUT, idempotencyKey: 'key-a' };
      const reissueOf = { ...moved, idempotencyKey: 'key-b' };

      it('claims the document before issuing anything', async () => {
        const { correct, claimDocument, acceptFe } = setup();
        await correct(reissueOf);
        expect(claimDocument).toHaveBeenCalledWith(
          expect.objectContaining({ document: REJECTED, idempotencyKey: 'key-b' }),
        );
        expect(claimDocument.mock.invocationCallOrder[0]).toBeLessThan(
          acceptFe.mock.invocationCallOrder[0],
        );
      });

      it('refuses a rewrite while a reissue holds the claim, before touching the row', async () => {
        let release!: () => void;
        const acceptGate = new Promise<void>((resolve) => (release = resolve));
        const { correct, rewriteDocument, recordReissue } = setup({
          serialize: true,
          acceptGate,
        });
        const reissuing = correct(reissueOf);
        // The reissue claimed in its first transaction and is waiting for the acceptance.
        await new Promise((resolve) => setImmediate(resolve));
        await expect(correct(rewrite)).rejects.toEqual(
          new DocumentNotCorrectableError('correction_in_progress'),
        );
        expect(rewriteDocument).not.toHaveBeenCalled();
        release();
        await expect(reissuing).resolves.toEqual(NEW_DOC);
        expect(recordReissue).toHaveBeenCalledOnce();
      });

      it('refuses a reissue after a rewrite committed, without issuing a replacement', async () => {
        const { correct, rewriteDocument, acceptFe, claimDocument } = setup({ serialize: true });
        const results = await Promise.allSettled([correct(rewrite), correct(reissueOf)]);
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
        expect((results[1] as PromiseRejectedResult).reason).toEqual(
          new DocumentNotCorrectableError('accepted'),
        );
        expect(rewriteDocument).toHaveBeenCalledOnce();
        expect(acceptFe).not.toHaveBeenCalled();
        expect(claimDocument).not.toHaveBeenCalled();
      });

      it('refuses another key while a reissue is in flight, before issuing', async () => {
        const claim = { idempotencyKey: 'key-b', requestHash: 'f'.repeat(64) };
        const { correct, acceptFe } = setup({ claim });
        await expect(correct({ ...moved, idempotencyKey: 'key-c' })).rejects.toEqual(
          new DocumentNotCorrectableError('correction_in_progress'),
        );
        expect(acceptFe).not.toHaveBeenCalled();
      });

      it('resumes its own claim with the same key and body', async () => {
        const claim = {
          idempotencyKey: 'key-b',
          requestHash: requestHash({ documentId: 'doc-1', payload: moved.payload }),
        };
        const { correct, claimDocument, recordReissue } = setup({ claim });
        await expect(correct(reissueOf)).resolves.toEqual(NEW_DOC);
        expect(claimDocument).not.toHaveBeenCalled();
        expect(recordReissue).toHaveBeenCalledOnce();
      });

      it('refuses the claim key with another body', async () => {
        const claim = { idempotencyKey: 'key-b', requestHash: 'f'.repeat(64) };
        const { correct } = setup({ claim });
        await expect(correct(reissueOf)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
      });

      it('releases the claim when the replacement is refused before it is issued', async () => {
        const { correct, releaseClaim, acceptFe } = setup();
        acceptFe.mockRejectedValueOnce(new InvoiceValidationError([]));
        await expect(correct(reissueOf)).rejects.toBeInstanceOf(InvoiceValidationError);
        expect(releaseClaim).toHaveBeenCalledOnce();
      });

      it('links the replacement an earlier attempt issued instead of releasing the claim when a retry is refused', async () => {
        const { correct, releaseClaim, recordReissue, acceptFe } = setup({
          replacementIssued: true,
        });
        acceptFe.mockRejectedValueOnce(new InvoiceValidationError([]));
        await expect(correct(reissueOf)).resolves.toEqual(NEW_DOC);
        expect(releaseClaim).not.toHaveBeenCalled();
        expect(recordReissue).toHaveBeenCalledOnce();
      });

      it('keeps the claim when the acceptance fails in an unknown way', async () => {
        const { correct, releaseClaim, acceptFe } = setup();
        acceptFe.mockRejectedValueOnce(new Error('connection reset'));
        await expect(correct(reissueOf)).rejects.toThrow('connection reset');
        expect(releaseClaim).not.toHaveBeenCalled();
      });
    });

    it('keeps the correction and answers with the void refusal, the same on every retry', async () => {
      const errors = [{ field: 'from', rule: 'range-used', sifenCode: '4066', message: 'used' }];
      const voidError = new VoidRefusedError(errors);
      const first = setup({ voidError });
      await expect(first.correct(moved)).resolves.toEqual({ ...NEW_DOC, voidRefused: errors });
      expect(first.recordReissue).toHaveBeenCalledOnce();
      const stored = {
        documentId: 'doc-1',
        cdc: CDC,
        requestHash: requestHash({ documentId: 'doc-1', payload: moved.payload }),
        replacement: NEW_DOC,
      };
      const retry = setup({ stored, voidError });
      await expect(retry.correct(moved)).resolves.toEqual({ ...NEW_DOC, voidRefused: errors });
      expect(retry.acceptFe).not.toHaveBeenCalled();
    });

    it('keeps the same CDC up to 72 h after the issue date and reissues after it (ADR-0008)', async () => {
      const at = (issuedAt: string) =>
        setup({ document: { ...REJECTED, issuedAt: new Date(issuedAt) } });
      // now = 2026-03-06T15:00Z: the 72 h deadline of this issue date is exactly now.
      const edge = at('2026-03-03T15:00:00Z');
      await edge.correct(INPUT);
      expect(edge.rewriteDocument).toHaveBeenCalledOnce();
      expect(edge.acceptFe).not.toHaveBeenCalled();

      const late = at('2026-03-03T14:59:59Z');
      await late.correct(INPUT);
      expect(late.rewriteDocument).not.toHaveBeenCalled();
      expect(late.acceptFe).toHaveBeenCalledOnce();
      expect(late.voidNumbers).toHaveBeenCalledOnce();
    });
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
