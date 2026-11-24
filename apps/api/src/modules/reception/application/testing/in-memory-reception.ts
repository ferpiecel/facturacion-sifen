import type { ReceivedDocument } from '../../domain/received-document.js';
import type {
  ArtifactMatch,
  CreateReceivedDocumentResult,
  ExtractionWrite,
  FieldConfidence,
  NewReceivedDocument,
  ReceivedArtifact,
  ReceivedDocumentAuditEntry,
  ReceivedDocumentGraph,
  ReceivedDocumentHeader,
  ReceivedDocumentHeaderInput,
  ReceivedDocumentItem,
  ReceivedDocumentRepository,
  ReceptionEventRequest,
  StateChange,
} from '../ports/received-document-repository.port.js';
import {
  ReceivedDocumentNotFoundError,
  VersionConflictError,
} from '../ports/received-document-repository.port.js';
import type { ExtractionUsageStore } from '../ports/extraction-usage-store.port.js';
import type { SolveReservation, SolveUsageStore } from '../ports/solve-usage-store.port.js';
import type { EkuatiaLookupJob, EkuatiaLookupQueue } from '../ports/ekuatia-lookup-queue.port.js';
import type { ExtractionJob, ReceptionJobQueue } from '../ports/reception-job-queue.port.js';
import { ReceptionQueueUnavailableError } from '../ports/reception-job-queue.port.js';
import type { StorageProvider } from '../ports/storage-provider.port.js';
import { StorageObjectNotFoundError } from '../ports/storage-provider.port.js';

/** Test doubles for the reception use cases; application specs must not import infrastructure. */

export class InMemoryStorage implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();
  upload(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body.slice());
    return Promise.resolve();
  }
  download(key: string): Promise<Uint8Array> {
    const body = this.objects.get(key);
    return body === undefined
      ? Promise.reject(new StorageObjectNotFoundError(key))
      : Promise.resolve(body.slice());
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
  presignedUrl(key: string): Promise<string> {
    return Promise.resolve(key);
  }
  ping(): Promise<void> {
    return Promise.resolve();
  }
}

const EMPTY_HEADER: ReceivedDocumentHeader = {
  documentType: null,
  cdc: null,
  timbrado: null,
  establishmentCode: null,
  expeditionPointCode: null,
  documentNumber: null,
  series: null,
  issuerRucBase: null,
  issuerRucDv: null,
  issuerLegalName: null,
  issuerTradeName: null,
  issuerAddress: null,
  issuerEconomicActivity: null,
  receiverRucBase: null,
  receiverRucDv: null,
  receiverLegalName: null,
  receiverType: null,
  issuedAt: null,
  dueOn: null,
  paidOn: null,
  paymentCondition: null,
  creditTermDays: null,
  paymentMethod: null,
  currency: 'PYG',
  exchangeRate: null,
  totalExempt: null,
  totalZeroRated: null,
  taxable5: null,
  taxable10: null,
  vat5: null,
  vat10: null,
  totalVat: null,
  totalDiscount: null,
  totalAmount: null,
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

interface Row {
  document: ReceivedDocument;
  header: ReceivedDocumentHeader;
  items: readonly ReceivedDocumentItem[];
  confidences: readonly FieldConfidence[];
  artifactId: string | null;
  updatedAt: Date;
}

export interface RecordedEvents {
  readonly documentId: string;
  readonly request: ReceptionEventRequest;
}

export class InMemoryReceptionRepository implements ReceivedDocumentRepository {
  readonly rows = new Map<string, Row>();
  readonly artifacts = new Map<string, ReceivedArtifact>();
  readonly events: RecordedEvents[] = [];
  readonly audits: ReceivedDocumentAuditEntry[] = [];
  /** Clock stamped on every write; specs move it to age a document. */
  clock: () => Date = () => new Date();
  /** Every aggregate status the document passed through a write, in order. */
  readonly statusLog: string[] = [];
  private seq = 0;

  private artifactBySha(sha256: string): ReceivedArtifact | null {
    return [...this.artifacts.values()].find((a) => a.sha256 === sha256) ?? null;
  }

  private rowByArtifact(artifactId: string): Row | null {
    return [...this.rows.values()].find((r) => r.artifactId === artifactId) ?? null;
  }

  private record(document: ReceivedDocument, request: ReceptionEventRequest | undefined): void {
    this.statusLog.push(document.status);
    if (request !== undefined) this.events.push({ documentId: document.id, request });
  }

  private requireRow(documentId: string, expectedVersion: number): Row {
    const row = this.rows.get(documentId);
    if (row === undefined) throw new ReceivedDocumentNotFoundError(documentId);
    if (row.document.version !== expectedVersion) {
      throw new VersionConflictError(documentId, expectedVersion, row.document.version);
    }
    return row;
  }

  document(id: string): ReceivedDocument {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no document ${id}`);
    return row.document;
  }

  create(_tenantId: string, input: NewReceivedDocument): Promise<CreateReceivedDocumentResult> {
    const known = input.artifact ? this.artifactBySha(input.artifact.sha256) : null;
    const existing = known ? this.rowByArtifact(known.id) : null;
    if (existing) return Promise.resolve({ created: false, document: existing.document });
    let artifactId: string | null = null;
    if (input.artifact) {
      artifactId = known?.id ?? `artifact-${String((this.seq += 1))}`;
      this.artifacts.set(artifactId, { ...input.artifact, id: artifactId });
    }
    this.rows.set(input.document.id, {
      document: input.document,
      header: { ...EMPTY_HEADER, ...input.header },
      items: input.items ?? [],
      confidences: input.confidences ?? [],
      artifactId,
      updatedAt: this.clock(),
    });
    this.record(input.document, input.events);
    return Promise.resolve({ created: true, document: input.document });
  }

  load(_tenantId: string, id: string): Promise<ReceivedDocumentGraph | null> {
    const row = this.rows.get(id);
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve({
      document: row.document,
      header: row.header,
      items: row.items,
      removedPositions: [],
      confidences: row.confidences,
      artifact: row.artifactId === null ? null : (this.artifacts.get(row.artifactId) ?? null),
      updatedAt: row.updatedAt,
    });
  }

  findByCdc(_tenantId: string, cdc: string): Promise<ReceivedDocument | null> {
    const row = [...this.rows.values()].find((r) => r.header.cdc === cdc);
    return Promise.resolve(row?.document ?? null);
  }

  findArtifactBySha256(_tenantId: string, sha256: string): Promise<ArtifactMatch | null> {
    const artifact = this.artifactBySha(sha256);
    if (artifact === null) return Promise.resolve(null);
    return Promise.resolve({
      artifact,
      document: this.rowByArtifact(artifact.id)?.document ?? null,
    });
  }

  save(
    _tenantId: string,
    document: ReceivedDocument,
    expectedVersion: number,
    change?: StateChange,
  ): Promise<void> {
    try {
      const row = this.requireRow(document.id, expectedVersion);
      const header: ReceivedDocumentHeaderInput = change?.header ?? {};
      this.rows.set(document.id, {
        ...row,
        document,
        header: { ...row.header, ...header },
        updatedAt: this.clock(),
      });
      this.record(document, change?.events);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('save failed'));
    }
  }

  saveExtraction(_tenantId: string, write: ExtractionWrite): Promise<void> {
    try {
      const row = this.requireRow(write.document.id, write.expectedVersion);
      this.rows.set(write.document.id, {
        ...row,
        document: write.document,
        header: { ...row.header, ...write.header },
        items: write.keepItems === true ? row.items : write.items,
        confidences: write.confidences,
        updatedAt: this.clock(),
      });
      this.record(write.document, write.events);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('save failed'));
    }
  }

  saveCorrection(): Promise<void> {
    return Promise.reject(new Error('not used by these specs'));
  }

  appendAudit(_tenantId: string, entry: ReceivedDocumentAuditEntry): Promise<void> {
    this.audits.push(entry);
    return Promise.resolve();
  }

  /** Test helper: makes the stored row look untouched since `at`. */
  touch(id: string, at: Date): void {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no document ${id}`);
    this.rows.set(id, { ...row, updatedAt: at });
  }
}

export class FakeJobQueue implements ReceptionJobQueue {
  readonly jobs: ExtractionJob[] = [];
  failWith: Error | null = null;
  enqueueExtraction(job: ExtractionJob): Promise<{ readonly enqueued: boolean }> {
    if (this.failWith !== null) {
      return Promise.reject(new ReceptionQueueUnavailableError('redis down'));
    }
    const known = this.jobs.some(
      (j) => j.documentId === job.documentId && j.attempt === job.attempt,
    );
    if (!known) this.jobs.push(job); // idempotent per (document, attempt), like the real adapter
    return Promise.resolve({ enqueued: !known });
  }
}

export class InMemoryExtractionUsageStore implements ExtractionUsageStore {
  readonly used = new Map<string, number>();
  releaseFails = false;
  tryConsume(tenantId: string, usageDate: string, cap: number): Promise<number | null> {
    const key = `${tenantId}|${usageDate}`;
    const current = this.used.get(key) ?? 0;
    if (current >= cap) return Promise.resolve(null);
    this.used.set(key, current + 1);
    return Promise.resolve(current + 1);
  }
  release(tenantId: string, usageDate: string): Promise<void> {
    if (this.releaseFails) return Promise.reject(new Error('db down'));
    const key = `${tenantId}|${usageDate}`;
    this.used.set(key, Math.max((this.used.get(key) ?? 0) - 1, 0));
    return Promise.resolve();
  }
}

export class InMemorySolveUsageStore implements SolveUsageStore {
  private readonly tenants = new Map<string, number>();
  private readonly globals = new Map<string, number>();
  releaseFails = false;

  tenantUsed(tenantId: string, usageDate: string): number {
    return this.tenants.get(`${tenantId}|${usageDate}`) ?? 0;
  }
  globalUsed(usageDate: string): number {
    return this.globals.get(usageDate) ?? 0;
  }
  tryConsume(
    tenantId: string,
    usageDate: string,
    caps: { readonly tenant: number; readonly global: number },
  ): Promise<SolveReservation> {
    if (this.tenantUsed(tenantId, usageDate) >= caps.tenant) {
      return Promise.resolve({ ok: false, scope: 'tenant' });
    }
    if (this.globalUsed(usageDate) >= caps.global) {
      return Promise.resolve({ ok: false, scope: 'global' });
    }
    this.tenants.set(`${tenantId}|${usageDate}`, this.tenantUsed(tenantId, usageDate) + 1);
    this.globals.set(usageDate, this.globalUsed(usageDate) + 1);
    return Promise.resolve({ ok: true });
  }
  release(tenantId: string, usageDate: string): Promise<void> {
    if (this.releaseFails) return Promise.reject(new Error('db down'));
    this.tenants.set(
      `${tenantId}|${usageDate}`,
      Math.max(this.tenantUsed(tenantId, usageDate) - 1, 0),
    );
    this.globals.set(usageDate, Math.max(this.globalUsed(usageDate) - 1, 0));
    return Promise.resolve();
  }
}

export class FakeEkuatiaLookupQueue implements EkuatiaLookupQueue {
  readonly jobs: EkuatiaLookupJob[] = [];
  failWith: Error | null = null;
  enqueueLookup(job: EkuatiaLookupJob): Promise<{ readonly enqueued: boolean }> {
    if (this.failWith !== null) {
      return Promise.reject(
        this.failWith instanceof ReceptionQueueUnavailableError
          ? this.failWith
          : new ReceptionQueueUnavailableError('redis down'),
      );
    }
    const known = this.jobs.some((j) => j.tenantId === job.tenantId && j.cdc === job.cdc);
    if (!known) this.jobs.push(job); // idempotent per (tenant, CDC), like the real adapter
    return Promise.resolve({ enqueued: !known });
  }
}
