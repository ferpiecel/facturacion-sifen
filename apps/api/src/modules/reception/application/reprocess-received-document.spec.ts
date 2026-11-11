import { describe, expect, it } from 'vitest';
import { computeCdcCheckDigit } from '../../emission/domain/cdc.js';
import { computeRucCheckDigit } from '../../fiscal-config/domain/ruc.js';
import {
  createReceivedDocument,
  transitionReceivedDocument,
  type ReceivedDocument,
} from '../domain/received-document.js';
import type { ReceivedDocumentSource } from '../domain/source.js';
import {
  InMemoryReceptionRepository,
  InMemoryStorage,
  FakeJobQueue,
} from './testing/in-memory-reception.js';
import {
  ReceivedDocumentNotFoundError,
  type NewReceivedArtifact,
} from './ports/received-document-repository.port.js';
import { ReceptionQueueUnavailableError } from './ports/reception-job-queue.port.js';
import { StorageUnavailableError } from './ports/storage-provider.port.js';
import {
  MalformedSifenXmlError,
  type ParsedSifenDocument,
  type SifenXmlParser,
} from './ports/sifen-xml-parser.port.js';
import {
  ArtifactNotAvailableError,
  ReprocessNotAllowedError,
  RETRY_PENDING_WINDOW_MS,
  createReprocessReceivedDocument,
} from './reprocess-received-document.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'key-1';
const API_KEY = { type: 'api_key', id: ACTOR } as const;
const NOW = new Date('2026-11-11T12:00:00.000Z');
const STALE_MS = 30 * 60_000;
const KEY = 'tenants/t/received/pdf/abc.pdf';

const ISSUER_BASE = '80000000';
const RECEIVER_BASE = '80000001';
const cdcBody = '018000000000010010000001120261106100000000'.padEnd(43, '1');
const CDC = `${cdcBody}${String(computeCdcCheckDigit(cdcBody))}`;

function parsedDoc(): ParsedSifenDocument {
  return {
    cdc: CDC,
    documentType: 1,
    issuer: { ruc: ISSUER_BASE, dv: String(computeRucCheckDigit(ISSUER_BASE)), legalName: 'ACME' },
    receiver: {
      ruc: RECEIVER_BASE,
      dv: String(computeRucCheckDigit(RECEIVER_BASE)),
      name: 'Cliente',
    },
    establishment: '001',
    expeditionPoint: '001',
    number: '0000001',
    documentNumber: '001-001-0000001',
    issueDate: '2026-11-06',
    currency: 'PYG',
    paymentCondition: 'cash',
    creditTermDays: null,
    totals: {
      exempt: '0',
      exonerated: '0',
      taxable5: '0',
      taxable10: '100000',
      vat5: '0',
      vat10: '10000',
      total: '110000',
    },
    items: [
      {
        description: 'Servicio',
        quantity: '1',
        unitPrice: '110000',
        discount: '0',
        taxRate: 10,
        taxBase: '100000',
        taxAmount: '10000',
        lineTotal: '110000',
      },
    ],
    authorizationProtocol: '123',
  };
}

type Status = 'received' | 'extracting' | 'extraction_failed' | 'needs_review' | 'confirmed';

function documentIn(status: Status, source: ReceivedDocumentSource): ReceivedDocument {
  let doc = createReceivedDocument({ id: 'doc-1', tenantId: TENANT, source, isOwnReceiver: true });
  const step = (to: Parameters<typeof transitionReceivedDocument>[1], reasons?: string[]) => {
    doc = transitionReceivedDocument(doc, to, {
      at: NOW,
      ...(reasons ? { reasons } : {}),
    }).document;
  };
  if (status === 'received') return doc;
  step('extracting');
  if (status === 'extracting') return doc;
  if (status === 'extraction_failed') {
    step('extraction_failed');
    return doc;
  }
  step('extracted');
  if (status === 'needs_review') step('needs_review', ['low_confidence']);
  else step('confirmed');
  return doc;
}

class Harness {
  readonly repository = new InMemoryReceptionRepository();
  readonly storage = new InMemoryStorage();
  readonly queue = new FakeJobQueue();
  parse: () => ParsedSifenDocument = parsedDoc;
  identity: { rucBase: string; dv: number } | null = {
    rucBase: RECEIVER_BASE,
    dv: computeRucCheckDigit(RECEIVER_BASE),
  };
  now = NOW;
  identityFails: Error | null = null;

  readonly parser: SifenXmlParser = { parse: () => this.parse() };

  readonly run = createReprocessReceivedDocument({
    repository: this.repository,
    storage: this.storage,
    parser: this.parser,
    fiscalIdentity: {
      getRucIdentity: () =>
        this.identityFails === null
          ? Promise.resolve(this.identity)
          : Promise.reject(this.identityFails),
    },
    queue: this.queue,
    now: () => this.now,
    staleExtractingAfterMs: STALE_MS,
  });

  async seed(
    status: Status,
    source: ReceivedDocumentSource = 'pdf',
    options: { artifact?: boolean; bytes?: boolean; errorCode?: string; corrected?: string[] } = {},
  ): Promise<void> {
    const artifact: NewReceivedArtifact = {
      storageKey: source === 'sifen_xml' ? 'tenants/t/received/sifen_xml/abc.xml' : KEY,
      contentType: source === 'sifen_xml' ? 'application/xml' : 'application/pdf',
      sha256: 'a'.repeat(64),
      sizeBytes: 3,
      originalName: null,
      pageCount: null,
    };
    await this.repository.create(TENANT, {
      document: documentIn(status, source),
      ...(options.artifact === false ? {} : { artifact }),
      ...(options.corrected === undefined
        ? {}
        : {
            confidences: options.corrected.map((fieldName) => ({
              fieldName,
              confidence: '0.900',
              extractedValue: null,
              correctedValue: 'x',
              correctedBy: ACTOR,
              correctedAt: NOW,
            })),
          }),
      ...(options.errorCode === undefined
        ? {}
        : { header: { extractionErrorCode: options.errorCode } }),
    });
    if (options.artifact !== false && options.bytes !== false) {
      this.storage.objects.set(artifact.storageKey, new Uint8Array([1, 2, 3]));
    }
    this.repository.touch('doc-1', NOW);
  }

  reprocess() {
    return this.run({ tenantId: TENANT, id: 'doc-1', actor: API_KEY });
  }
}

describe('reprocessReceivedDocument (vision sources)', () => {
  it.each(['pdf', 'photo'] as const)(
    'queues a %s document that never left received and audits the request',
    async (source) => {
      const h = new Harness();
      await h.seed('received', source);
      h.now = new Date(NOW.getTime() + STALE_MS);
      const result = await h.reprocess();

      expect(result).toMatchObject({ kind: 'queued', document: { id: 'doc-1' } });
      // Never collides with the upload job, whose id carries attempt 1.
      expect(h.queue.jobs).toEqual([{ tenantId: TENANT, documentId: 'doc-1', attempt: 2 }]);
      expect(h.repository.document('doc-1').status).toBe('received');
      expect(h.repository.audits).toEqual([
        expect.objectContaining({
          documentId: 'doc-1',
          actor: API_KEY,
          action: 'received_document.reprocess_requested',
        }),
      ]);
    },
  );

  it('queues an extraction_failed document with a job id past its previous attempts', async () => {
    const h = new Harness();
    await h.seed('extraction_failed');
    const before = h.repository.document('doc-1');
    await h.reprocess();

    expect(h.queue.jobs).toEqual([
      { tenantId: TENANT, documentId: 'doc-1', attempt: before.extractionAttempts + 2 },
    ]);
    // The worker claims it (and bumps the version); the request itself changes no state.
    expect(h.repository.document('doc-1')).toEqual(before);
  });

  it('is idempotent for a double click: one job', async () => {
    const h = new Harness();
    await h.seed('extraction_failed');
    await h.reprocess();
    await h.reprocess();
    expect(h.queue.jobs).toHaveLength(1);
  });

  it('does nothing for an extracting document that was touched recently', async () => {
    const h = new Harness();
    await h.seed('extracting');
    h.now = new Date(NOW.getTime() + STALE_MS - 1);
    const result = await h.reprocess();

    expect(result).toMatchObject({ kind: 'in_progress' });
    expect(h.queue.jobs).toEqual([]);
    expect(h.repository.audits).toEqual([]);
    expect(h.repository.document('doc-1').status).toBe('extracting');
  });

  it('recovers a stalled extracting document: failed without a webhook, then queued', async () => {
    const h = new Harness();
    await h.seed('extracting');
    h.now = new Date(NOW.getTime() + STALE_MS);
    const result = await h.reprocess();

    expect(result.kind).toBe('queued');
    expect(h.repository.document('doc-1').status).toBe('extraction_failed');
    expect(h.repository.events).toEqual([]);
    expect(h.queue.jobs).toHaveLength(1);
    expect(h.repository.rows.get('doc-1')?.header.extractionErrorCode).toBe('extraction_stalled');
  });

  it.each(['needs_review', 'confirmed'] as const)(
    'queues a %s document as a reprocess job and keeps its state until the worker claims it',
    async (status) => {
      const h = new Harness();
      await h.seed(status);
      const before = h.repository.document('doc-1');
      const result = await h.reprocess();

      expect(result).toMatchObject({ kind: 'queued' });
      expect(h.queue.jobs).toEqual([
        {
          tenantId: TENANT,
          documentId: 'doc-1',
          attempt: before.extractionAttempts + 2,
          reprocess: true,
        },
      ]);
      expect(h.repository.document('doc-1')).toEqual(before);
      expect(h.repository.audits[0]).toMatchObject({
        before: { status, version: before.version },
        after: { status, queued: true },
      });
    },
  );

  it('answers a double click on a reviewed document with one job and one audit entry', async () => {
    const h = new Harness();
    await h.seed('confirmed');
    await h.reprocess();
    await h.reprocess();
    expect(h.queue.jobs).toHaveLength(1);
    expect(h.repository.audits).toHaveLength(1);
  });

  it('records in the audit entry which human corrections the re-extraction will keep', async () => {
    const h = new Harness();
    await h.seed('confirmed', 'pdf', { corrected: ['totals', 'items'] });
    await h.reprocess();
    expect(h.repository.audits[0]?.after).toMatchObject({
      queued: true,
      preservedCorrections: ['totals', 'items'],
    });
  });

  it('does not wait out the retry window for a reviewed document', async () => {
    const h = new Harness();
    await h.seed('needs_review');
    expect(await h.reprocess()).toMatchObject({ kind: 'queued' });
  });

  it('leaves a recent received document alone: its upload job may still be queued', async () => {
    const h = new Harness();
    await h.seed('received');
    h.now = new Date(NOW.getTime() + STALE_MS - 1);
    const result = await h.reprocess();

    expect(result).toMatchObject({ kind: 'in_progress' });
    expect(h.queue.jobs).toEqual([]);
    expect(h.repository.audits).toEqual([]);
  });

  it.each(['llm_rate_limited', 'llm_provider_error', 'internal_error'])(
    'leaves a %s failure alone while the queue may still retry it',
    async (errorCode) => {
      const h = new Harness();
      await h.seed('extraction_failed', 'pdf', { errorCode });
      h.now = new Date(NOW.getTime() + RETRY_PENDING_WINDOW_MS - 1);
      expect(await h.reprocess()).toMatchObject({ kind: 'in_progress' });
      expect(h.queue.jobs).toEqual([]);

      h.now = new Date(NOW.getTime() + RETRY_PENDING_WINDOW_MS);
      expect(await h.reprocess()).toMatchObject({ kind: 'queued' });
      expect(h.queue.jobs).toHaveLength(1);
    },
  );

  it('queues a final failure (no retry is ever coming) right away', async () => {
    const h = new Harness();
    await h.seed('extraction_failed', 'pdf', { errorCode: 'llm_disabled' });
    expect(await h.reprocess()).toMatchObject({ kind: 'queued' });
  });

  it('audits a double click once: the second request enqueues nothing new', async () => {
    const h = new Harness();
    await h.seed('extraction_failed');
    await h.reprocess();
    const second = await h.reprocess();

    expect(second.kind).toBe('queued');
    expect(h.repository.audits).toHaveLength(1);
  });

  it('audits the document as loaded, not as recovered from a stall', async () => {
    const h = new Harness();
    await h.seed('extracting');
    const loaded = h.repository.document('doc-1');
    h.now = new Date(NOW.getTime() + STALE_MS);
    await h.reprocess();

    expect(h.repository.audits[0]).toMatchObject({
      before: { status: 'extracting', version: loaded.version },
      after: { status: 'extraction_failed', queued: true },
    });
  });

  it('records a portal user as a user in the audit entry', async () => {
    const h = new Harness();
    await h.seed('extraction_failed');
    await h.run({ tenantId: TENANT, id: 'doc-1', actor: { type: 'user', id: 'user-1' } });
    expect(h.repository.audits[0]?.actor).toEqual({ type: 'user', id: 'user-1' });
  });

  it('reports a storage provider failure as StorageUnavailableError', async () => {
    const h = new Harness();
    await h.seed('extraction_failed');
    h.storage.exists = () => Promise.reject(new Error('s3 down'));
    await expect(h.reprocess()).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('refuses a document without a stored artifact', async () => {
    const h = new Harness();
    await h.seed('extraction_failed', 'pdf', { artifact: false });
    await expect(h.reprocess()).rejects.toBeInstanceOf(ArtifactNotAvailableError);
    expect(h.queue.jobs).toEqual([]);
  });

  it('refuses a document whose stored object is gone', async () => {
    const h = new Harness();
    await h.seed('extraction_failed', 'pdf', { bytes: false });
    await expect(h.reprocess()).rejects.toBeInstanceOf(ArtifactNotAvailableError);
  });

  it('reports a missing document', async () => {
    const h = new Harness();
    await expect(h.reprocess()).rejects.toBeInstanceOf(ReceivedDocumentNotFoundError);
  });

  it('propagates a queue outage without auditing', async () => {
    const h = new Harness();
    await h.seed('received');
    h.now = new Date(NOW.getTime() + STALE_MS);
    h.queue.failWith = new Error('down');
    await expect(h.reprocess()).rejects.toBeInstanceOf(ReceptionQueueUnavailableError);
    expect(h.repository.audits).toEqual([]);
  });
});

describe('reprocessReceivedDocument (SIFEN XML)', () => {
  it('re-reads an unreadable XML from the stored bytes and confirms it', async () => {
    const h = new Harness();
    await h.seed('extraction_failed', 'sifen_xml');
    const before = h.repository.document('doc-1');
    const result = await h.reprocess();

    expect(result).toMatchObject({
      kind: 'reprocessed',
      events: ['reception.document.confirmed'],
      document: { status: 'confirmed' },
    });
    expect(h.queue.jobs).toEqual([]);
    const stored = h.repository.document('doc-1');
    // failed -> extracting bumps once, extracted -> confirmed bumps once.
    expect(stored.version).toBe(before.version + 2);
    expect(h.repository.rows.get('doc-1')?.header).toMatchObject({
      cdc: CDC,
      extractionErrorCode: null,
    });
    expect(h.repository.rows.get('doc-1')?.items).toHaveLength(1);
    expect(h.repository.events.at(-1)?.request.types).toEqual(['reception.document.confirmed']);
    expect(h.repository.audits).toEqual([
      expect.objectContaining({ action: 'received_document.reprocessed', actor: API_KEY }),
    ]);
  });

  it('goes to needs_review when the re-read XML fails validation', async () => {
    const h = new Harness();
    await h.seed('extraction_failed', 'sifen_xml');
    h.parse = () => ({ ...parsedDoc(), totals: { ...parsedDoc().totals, total: '5' } });
    const result = await h.reprocess();

    expect(result).toMatchObject({ kind: 'reprocessed', document: { status: 'needs_review' } });
  });

  it('stays extraction_failed with the new code when the XML is still unreadable', async () => {
    const h = new Harness();
    await h.seed('extraction_failed', 'sifen_xml');
    h.parse = () => {
      throw new MalformedSifenXmlError('not_well_formed');
    };
    const result = await h.reprocess();

    expect(result).toMatchObject({ kind: 'failed', code: 'malformed_xml.not_well_formed' });
    expect(h.repository.document('doc-1').status).toBe('extraction_failed');
    expect(h.repository.rows.get('doc-1')?.header.extractionErrorCode).toBe(
      'malformed_xml.not_well_formed',
    );
    expect(h.repository.audits).toHaveLength(1);
  });

  it('fails with duplicate_document when another document already owns the CDC', async () => {
    const h = new Harness();
    await h.seed('extraction_failed', 'sifen_xml');
    await h.repository.create(TENANT, {
      document: createReceivedDocument({
        id: 'other',
        tenantId: TENANT,
        source: 'sifen_xml',
        isOwnReceiver: true,
      }),
      header: { cdc: CDC },
    });
    const result = await h.reprocess();
    expect(result).toMatchObject({ kind: 'failed', code: 'duplicate_document' });
  });

  it.each(['needs_review', 'confirmed'] as const)(
    'refuses a parsed %s XML: the same bytes cannot read differently',
    async (status) => {
      const h = new Harness();
      await h.seed(status, 'sifen_xml');
      await expect(h.reprocess()).rejects.toBeInstanceOf(ReprocessNotAllowedError);
    },
  );
  it.each([
    ['the identity port', (h: Harness) => (h.identityFails = new Error('db down'))],
    [
      'the parser',
      (h: Harness) =>
        (h.parse = () => {
          throw new TypeError('boom');
        }),
    ],
  ])('never leaves the document stuck in extracting when %s throws', async (_name, arm) => {
    const h = new Harness();
    await h.seed('extraction_failed', 'sifen_xml');
    arm(h);
    await expect(h.reprocess()).rejects.toThrow();

    expect(h.repository.document('doc-1').status).toBe('extraction_failed');
    expect(h.repository.rows.get('doc-1')?.header.extractionErrorCode).toBe('internal_error');
  });
});
