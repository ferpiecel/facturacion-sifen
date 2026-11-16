import { createHash } from 'node:crypto';
import { createReceivedDocument, type ReceivedDocument } from '../domain/received-document.js';
import { imageMediaType, sniffUpload } from '../domain/upload-sniff.js';
import type { IngestSifenXmlInput, IngestSifenXmlResult } from './ingest-sifen-xml.js';
import type {
  NewReceivedArtifact,
  ReceivedDocumentRepository,
} from './ports/received-document-repository.port.js';
import type { ReceptionJobQueue } from './ports/reception-job-queue.port.js';
import type { StorageProvider } from './ports/storage-provider.port.js';

export interface IngestUploadDeps {
  readonly repository: ReceivedDocumentRepository;
  readonly storage: StorageProvider;
  readonly queue: ReceptionJobQueue;
  /** The XML path (`IngestSifenXml`): anything that sniffs as XML goes there untouched. */
  readonly ingestXml: { execute(input: IngestSifenXmlInput): Promise<IngestSifenXmlResult> };
  readonly newId: () => string;
}

export interface IngestUploadInput {
  readonly tenantId: string;
  readonly bytes: Uint8Array;
  /** What the client declared. Informational only: the bytes decide, never this header. */
  readonly declaredContentType?: string | null;
  readonly originalName?: string | null;
}

export type IngestUploadResult =
  /** XML upload, handled by the SIFEN XML use case (200/201 semantics are its own). */
  | { readonly kind: 'xml'; readonly result: IngestSifenXmlResult }
  /** Not XML, PDF, PNG or JPEG. */
  | { readonly kind: 'unsupported_source' }
  /** Stored, document created in `received` and the extraction job enqueued (HTTP 202). */
  | { readonly kind: 'accepted'; readonly document: ReceivedDocument }
  /**
   * The same bytes were uploaded before (HTTP 200 with the existing document). `requeued` is true
   * when that document was still `received` (an earlier enqueue never happened) and the job was
   * enqueued again now.
   */
  | { readonly kind: 'duplicate'; readonly document: ReceivedDocument; readonly requeued: boolean }
  /**
   * The queue refused the job. Nothing is lost: the upload is stored and the document stays in
   * `received`; the caller answers 503. Recovery: uploading the same bytes again re-enqueues it,
   * and reprocess (R5.8) must accept a `received` document too.
   */
  | {
      readonly kind: 'queue_unavailable';
      readonly document: ReceivedDocument;
      /** False when the document already existed before this call. */
      readonly created: boolean;
    };

interface Detected {
  readonly source: 'pdf' | 'photo';
  readonly contentType: string;
  readonly extension: string;
}

function detect(bytes: Uint8Array): Detected | null {
  const kind = sniffUpload(bytes);
  if (kind === 'pdf') return { source: 'pdf', contentType: 'application/pdf', extension: 'pdf' };
  if (kind !== 'image') return null;
  const mediaType = imageMediaType(bytes);
  if (mediaType === null) return null;
  return {
    source: 'photo',
    contentType: mediaType,
    extension: mediaType === 'image/png' ? 'png' : 'jpg',
  };
}

/**
 * Entry point for uploads (reception R5.6a). The bytes are classified by their magic numbers; XML
 * keeps its synchronous path, PDF and photos are stored, deduplicated by sha256 per tenant,
 * registered as a `received` document and handed to the extraction queue. Logging is the caller's
 * job and must carry ids only.
 */
export class IngestUpload {
  constructor(private readonly deps: IngestUploadDeps) {}

  async execute(input: IngestUploadInput): Promise<IngestUploadResult> {
    const { tenantId, bytes } = input;
    if (sniffUpload(bytes) === 'xml') {
      const result = await this.deps.ingestXml.execute({
        tenantId,
        xml: bytes,
        originalName: input.originalName ?? null,
      });
      return { kind: 'xml', result };
    }
    const detected = detect(bytes);
    if (detected === null) return { kind: 'unsupported_source' };

    const { repository, storage } = this.deps;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const known = await repository.findArtifactBySha256(tenantId, sha256);
    if (known?.document) return this.duplicate(tenantId, known.document);

    // The key is content-addressed, so a concurrent upload of the same bytes writes the same object.
    const storageKey = `tenants/${tenantId}/received/${detected.source}/${sha256}.${detected.extension}`;
    await storage.upload(storageKey, bytes, { contentType: detected.contentType });
    const artifact: NewReceivedArtifact = {
      storageKey,
      contentType: detected.contentType,
      sha256,
      sizeBytes: bytes.byteLength,
      originalName: input.originalName ?? null,
      pageCount: null,
    };
    const created = await repository.create(tenantId, {
      document: createReceivedDocument({
        id: this.deps.newId(),
        tenantId,
        source: detected.source,
        // The receiver is unknown until extraction; until then nothing contradicts the tenant.
        isOwnReceiver: true,
      }),
      artifact,
    });
    if (!created.created) return this.duplicate(tenantId, created.document);

    const queued = await this.enqueue(tenantId, created.document);
    return queued
      ? { kind: 'accepted', document: created.document }
      : { kind: 'queue_unavailable', document: created.document, created: true };
  }

  private async duplicate(
    tenantId: string,
    document: ReceivedDocument,
  ): Promise<IngestUploadResult> {
    if (document.status !== 'received') return { kind: 'duplicate', document, requeued: false };
    const queued = await this.enqueue(tenantId, document);
    return queued
      ? { kind: 'duplicate', document, requeued: true }
      : { kind: 'queue_unavailable', document, created: false };
  }

  /** The queue contract is idempotent per document, so re-enqueueing is always safe. */
  private async enqueue(tenantId: string, document: ReceivedDocument): Promise<boolean> {
    try {
      await this.deps.queue.enqueueExtraction({ tenantId, documentId: document.id });
      return true;
    } catch {
      return false;
    }
  }
}
