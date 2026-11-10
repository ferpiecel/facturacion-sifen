import { describe, expect, it } from 'vitest';
import { computeRucCheckDigit } from '../../fiscal-config/domain/ruc.js';
import { rehydrateReceivedDocument, type ReceivedDocument } from '../domain/received-document.js';
import {
  InvalidCorrectionError,
  InvalidReceivedDocumentStateError,
  ValidationFailedError,
  createCorrectReceivedDocument,
  type CorrectReceivedDocumentInput,
} from './correct-received-document.js';
import {
  ReceivedDocumentNotFoundError,
  VersionConflictError,
  type CorrectionWrite,
  type ReceivedDocumentGraph,
  type ReceivedDocumentHeader,
  type ReceivedDocumentItem,
  type ReceivedDocumentRepository,
} from './ports/received-document-repository.port.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const AT = new Date('2026-11-10T12:00:00.000Z');
const ISSUER = '80000000';

const HEADER: ReceivedDocumentHeader = {
  documentType: 1,
  cdc: null,
  timbrado: '12345678',
  establishmentCode: '001',
  expeditionPointCode: '001',
  documentNumber: '0000001',
  series: null,
  issuerRucBase: ISSUER,
  issuerRucDv: computeRucCheckDigit(ISSUER),
  issuerLegalName: 'ACME',
  issuerTradeName: null,
  issuerAddress: null,
  issuerEconomicActivity: null,
  receiverRucBase: '80000001',
  receiverRucDv: computeRucCheckDigit('80000001'),
  receiverLegalName: 'Cliente',
  receiverType: null,
  issuedAt: new Date('2026-11-06T00:00:00.000Z'),
  dueOn: null,
  paidOn: null,
  paymentCondition: 'cash',
  creditTermDays: null,
  paymentMethod: null,
  currency: 'PYG',
  exchangeRate: null,
  totalExempt: '0.00000000',
  totalZeroRated: '0.00000000',
  taxable5: '0.00000000',
  taxable10: '100000.00000000',
  vat5: '0.00000000',
  vat10: '10000.00000000',
  totalVat: '10000.00000000',
  totalDiscount: null,
  totalAmount: '100.00000000', // wrong on purpose: the blocks add up to 110000
  totalPyg: null,
  sifenStatus: 'unknown',
  sifenAuthorizedAt: null,
  sifenProtocolNumber: null,
  rawData: null,
  extractionErrorCode: null,
  confirmedBy: null,
  correctedAt: null,
  correctedBy: null,
};

const line = (position: number, subtotal: string): ReceivedDocumentItem => ({
  position,
  description: `Line ${String(position)}`,
  productCode: null,
  quantity: '1.00000000',
  unitOfMeasure: null,
  unitPrice: subtotal,
  discount: null,
  subtotal,
  vatRate: 10,
  taxableBase: null,
  vatAmount: null,
});

function document(
  status: ReceivedDocument['status'],
  over: Partial<ReceivedDocument> = {},
): ReceivedDocument {
  const needsReview = status === 'needs_review';
  return rehydrateReceivedDocument({
    id: DOC_ID,
    tenantId: TENANT,
    source: 'sifen_xml',
    status,
    version: 2,
    needsReview,
    needsReviewReasons: needsReview ? ['totals_blocks_sum_mismatch'] : [],
    isOwnReceiver: true,
    confidenceOverall: '1.0',
    extractionAttempts: 1,
    confirmedAt: status === 'confirmed' ? AT : null,
    ...over,
  });
}

const confidence = (fieldName: string) => ({
  fieldName,
  confidence: '1.0',
  extractedValue: null,
  correctedValue: null,
  correctedBy: null,
  correctedAt: null,
});

/** In-memory repository: applies a CorrectionWrite to the stored graph like the Drizzle adapter. */
class FakeRepository implements ReceivedDocumentRepository {
  readonly writes: CorrectionWrite[] = [];
  constructor(public graph: ReceivedDocumentGraph | null) {}

  load(tenantId: string, id: string) {
    return Promise.resolve(
      this.graph?.document.tenantId === tenantId && this.graph.document.id === id
        ? this.graph
        : null,
    );
  }

  saveCorrection(_tenantId: string, write: CorrectionWrite) {
    const current = this.graph;
    if (current === null) return Promise.reject(new ReceivedDocumentNotFoundError(DOC_ID));
    if (current.document.version !== write.expectedVersion) {
      return Promise.reject(
        new VersionConflictError(DOC_ID, write.expectedVersion, current.document.version),
      );
    }
    this.writes.push(write);
    const removed = new Set(write.items.removedPositions);
    const items = [...current.items.filter((item) => !removed.has(item.position))].filter(
      (item) => !write.items.upserts.some((u) => u.position === item.position),
    );
    this.graph = {
      ...current,
      document: write.document,
      header: { ...current.header, ...write.header },
      items: [...items, ...write.items.upserts].sort((a, b) => a.position - b.position),
      removedPositions: [...current.removedPositions, ...write.items.removedPositions],
    };
    return Promise.resolve();
  }

  create = () => Promise.reject(new Error('unused'));
  findByCdc = () => Promise.resolve(null);
  findArtifactBySha256 = () => Promise.resolve(null);
  save = () => Promise.reject(new Error('unused'));
}

function setup(
  status: ReceivedDocument['status'] = 'needs_review',
  extra: Partial<ReceivedDocumentGraph> = {},
  over: Partial<ReceivedDocument> = {},
) {
  const repository = new FakeRepository({
    document: document(status, over),
    header: HEADER,
    items: [line(1, '110000.00000000')],
    removedPositions: [],
    confidences: ['issuer_ruc', 'totals', 'items'].map(confidence),
    artifact: null,
    ...extra,
  });
  const correct = createCorrectReceivedDocument({ repository, now: () => AT });
  const run = (input: Partial<CorrectReceivedDocumentInput> = {}) =>
    correct({
      tenantId: TENANT,
      id: DOC_ID,
      expectedVersion: 2,
      actorId: 'key-1',
      ...input,
    });
  return { repository, run };
}

const FIX_TOTAL = { header: { totalAmount: '110000' } };

/** Spec: reception R4.4. Correct and confirm a received document in one call. */
describe('correctReceivedDocument', () => {
  it('persists a correction without confirming and refreshes the reasons', async () => {
    const { repository, run } = setup();
    const result = await run({ header: { totalAmount: '5000' } });
    expect(result).toMatchObject({ replayed: false, events: [] });
    expect(result.document).toMatchObject({ status: 'needs_review', version: 3 });
    expect(result.document.needsReviewReasons).toContain('totals_blocks_sum_mismatch');
    const [write] = repository.writes;
    expect(write.header).toMatchObject({
      totalAmount: '5000',
      correctedBy: 'key-1',
      correctedAt: AT,
    });
    expect(write.header).not.toHaveProperty('confirmedBy');
    expect(write.expectedVersion).toBe(2);
    expect(write.audit.action).toBe('received_document.corrected');
  });

  it('marks a now-valid document as awaiting confirmation instead of confirming it', async () => {
    const { run } = setup();
    const result = await run(FIX_TOTAL);
    expect(result.document.status).toBe('needs_review');
    expect(result.document.needsReviewReasons).toEqual(['awaiting_confirmation']);
  });

  it('corrects and confirms in a single request', async () => {
    const { repository, run } = setup();
    const result = await run({ ...FIX_TOTAL, confirm: true });
    expect(result.document).toMatchObject({ status: 'confirmed', version: 3, confirmedAt: AT });
    expect(result.events).toEqual(['reception.document.confirmed']);
    const [write] = repository.writes;
    expect(write.header).toMatchObject({ confirmedBy: 'key-1', correctedBy: 'key-1' });
    expect(write.audit.action).toBe('received_document.confirmed');
    expect(write.confidences).toEqual([
      { fieldName: 'totals', correctedValue: expect.stringContaining('totalAmount') as string },
    ]);
  });

  it('confirms without changes when the document is already valid', async () => {
    const { repository, run } = setup('needs_review', {
      header: { ...HEADER, totalAmount: '110000.00000000' },
    });
    const result = await run({ confirm: true });
    expect(result.document.status).toBe('confirmed');
    expect(repository.writes[0].header).not.toHaveProperty('correctedBy');
  });

  it('rejects confirm with reason codes while validations fail and writes nothing', async () => {
    const { repository, run } = setup();
    const failure = await run({ header: { currency: 'USD' }, confirm: true }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ValidationFailedError);
    expect((failure as ValidationFailedError).reasons).toContain('totals_blocks_sum_mismatch');
    expect(repository.writes).toHaveLength(0);
    expect(repository.graph?.document.version).toBe(2);
  });

  it('rejects a stale version with the current one, writing nothing', async () => {
    const { repository, run } = setup();
    const failure = await run({ ...FIX_TOTAL, expectedVersion: 1 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(VersionConflictError);
    expect((failure as VersionConflictError).currentVersion).toBe(2);
    expect(repository.writes).toHaveLength(0);
  });

  it('replaying the exact request after it was applied answers 200 without a second write', async () => {
    const { repository, run } = setup();
    const request = { ...FIX_TOTAL, confirm: true };
    const first = await run(request);
    const replay = await run(request);
    expect(replay).toMatchObject({ replayed: true, events: [] });
    expect(replay.document.version).toBe(first.document.version);
    expect(repository.writes).toHaveLength(1);
  });

  it('does not treat a different payload at the old version as a replay', async () => {
    const { run } = setup();
    await run({ ...FIX_TOTAL, confirm: true });
    await expect(run({ header: { totalAmount: '999' }, confirm: true })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
  });

  it('does not treat another actor as a replay', async () => {
    const { run } = setup();
    await run({ ...FIX_TOTAL, confirm: true });
    await expect(run({ ...FIX_TOTAL, confirm: true, actorId: 'key-2' })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
  });

  it('answers a no-op at the current version without writing or bumping', async () => {
    const { repository, run } = setup();
    const result = await run({ header: { currency: 'PYG' } });
    expect(result).toMatchObject({ replayed: false, events: [] });
    expect(result.document.version).toBe(2);
    expect(repository.writes).toHaveLength(0);
  });

  it('compares decimals by value, not by text', async () => {
    const { repository, run } = setup('needs_review', {
      header: { ...HEADER, totalAmount: '110000.00000000' },
    });
    await run({ header: { totalAmount: '110000' } });
    expect(repository.writes).toHaveLength(0);
  });

  describe('items', () => {
    it('modifies, adds and soft-removes by position', async () => {
      const { repository, run } = setup('needs_review', {
        items: [line(1, '60000'), line(2, '50000')],
      });
      await run({
        header: { totalAmount: '110000' },
        items: [
          { position: 1, subtotal: '70000' },
          { position: 2, remove: true },
          { position: 3, description: 'New', subtotal: '40000' },
        ],
      });
      const [write] = repository.writes;
      expect(write.items.removedPositions).toEqual([2]);
      expect(write.items.upserts.map((i) => [i.position, i.subtotal])).toEqual([
        [1, '70000'],
        [3, '40000'],
      ]);
      expect(write.items.upserts[0].description).toBe('Line 1');
      expect(write.confidences.map((c) => c.fieldName)).toEqual(['totals', 'items']);
    });

    it('excludes removed items from validation and from the stored graph', async () => {
      const { repository, run } = setup(
        'needs_review',
        {
          items: [line(1, '110000'), line(2, '999')],
          header: { ...HEADER, totalAmount: '110000' },
        },
        { needsReviewReasons: ['items_sum_mismatch'] },
      );
      const result = await run({ items: [{ position: 2, remove: true }], confirm: true });
      expect(result.document.status).toBe('confirmed');
      expect(repository.graph?.items.map((i) => i.position)).toEqual([1]);
      expect(repository.graph?.removedPositions).toEqual([2]);
    });

    it('treats removing an already removed item as a no-op (idempotent)', async () => {
      const { repository, run } = setup('needs_review', { removedPositions: [2] });
      await run({ items: [{ position: 2, remove: true }] });
      expect(repository.writes).toHaveLength(0);
    });

    it('refuses to remove an unknown position, edit a removed one, or reuse it', async () => {
      const { run } = setup('needs_review', { removedPositions: [2] });
      for (const items of [
        [{ position: 9, remove: true as const }],
        [{ position: 2, description: 'x' }],
        [{ position: 1 }, { position: 1, description: 'twice' }],
        [{ position: 0, description: 'x' }],
      ]) {
        await expect(run({ items })).rejects.toBeInstanceOf(InvalidCorrectionError);
      }
    });
  });

  it('edits a confirmed document: bumps the version, keeps confirmed_by, emits updated', async () => {
    const { repository, run } = setup('confirmed', {
      header: { ...HEADER, totalAmount: '110000.00000000', confirmedBy: 'key-0' },
    });
    const result = await run({ header: { issuerTradeName: 'ACME SRL' } });
    expect(result.document).toMatchObject({ status: 'confirmed', version: 3, confirmedAt: AT });
    expect(result.events).toEqual(['reception.document.updated']);
    const header = repository.writes[0].header;
    expect(header).toMatchObject({ issuerTradeName: 'ACME SRL', correctedBy: 'key-1' });
    expect(header).not.toHaveProperty('confirmedBy');
  });

  it('refuses an edit that would leave a confirmed document invalid', async () => {
    const { repository, run } = setup('confirmed', {
      header: { ...HEADER, totalAmount: '110000.00000000' },
    });
    await expect(run({ header: { totalAmount: '5' } })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(repository.writes).toHaveLength(0);
  });

  it('is silent for documents that are not the tenant receiver', async () => {
    const { run } = setup('needs_review', {}, { isOwnReceiver: false });
    const result = await run({ ...FIX_TOTAL, confirm: true });
    expect(result.document.status).toBe('confirmed');
    expect(result.events).toEqual([]);
  });

  it.each(['received', 'extracting', 'extracted', 'extraction_failed'] as const)(
    'refuses a document in %s',
    async (status) => {
      const { run } = setup(status);
      const failure = await run(FIX_TOTAL).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(InvalidReceivedDocumentStateError);
      expect((failure as InvalidReceivedDocumentStateError).status).toBe(status);
    },
  );

  it('reports an unknown document', async () => {
    const { run } = setup();
    await expect(run({ id: '33333333-3333-4333-8333-333333333333' })).rejects.toBeInstanceOf(
      ReceivedDocumentNotFoundError,
    );
  });

  it('rejects malformed decimals and dates', async () => {
    const { run } = setup();
    for (const header of [
      { totalAmount: 'abc' },
      { totalAmount: '1234567890123456' },
      { issuedOn: '2026-02-31' },
      { issuerRuc: 'x' },
    ]) {
      await expect(run({ header })).rejects.toBeInstanceOf(InvalidCorrectionError);
    }
  });

  it('maps RUC, date and sequence patches onto stored columns', async () => {
    const { repository, run } = setup();
    await run({
      header: {
        issuerRuc: '80.000.005-3',
        issuedOn: '2026-11-07',
        documentSequence: '0000002',
        paymentCondition: 'credit',
      },
    });
    const [write] = repository.writes;
    expect(write.header).toMatchObject({
      issuerRucBase: '80000005',
      issuerRucDv: 3,
      issuedAt: new Date('2026-11-07T00:00:00.000Z'),
      documentNumber: '0000002',
      paymentCondition: 'credit',
    });
    expect(write.confidences.map((c) => c.fieldName)).toEqual([
      'issuer_ruc',
      'issued_on',
      'document_number',
      'payment_condition',
    ]);
  });

  it('records one audit entry with before and after values', async () => {
    const { repository, run } = setup();
    await run({ header: { issuerLegalName: 'ACME SA' } });
    const { audit } = repository.writes[0];
    expect(audit.before).toMatchObject({ version: 2, status: 'needs_review' });
    expect(audit.before).toMatchObject({ header: { issuerLegalName: 'ACME' } });
    expect(audit.after).toMatchObject({ version: 3, header: { issuerLegalName: 'ACME SA' } });
  });
});
