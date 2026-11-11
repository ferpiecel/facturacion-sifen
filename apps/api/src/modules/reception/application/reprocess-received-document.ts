import {
  rehydrateReceivedDocument,
  transitionReceivedDocument,
  type ReceivedDocument,
} from '../domain/received-document.js';
import type { ReceivedDocumentStatus } from '../domain/received-document-status.js';
import { validateReceivedDocument } from '../domain/received-document-validation.js';
import { matchReceiver } from '../domain/receiver-match.js';
import type { ReceptionEventType } from '../domain/reception-events.js';
import {
  CONFIDENCE_FIELDS,
  FULL_CONFIDENCE,
  sifenXmlConfidence,
  sifenXmlFailureCode,
  sifenXmlHeader,
  sifenXmlItem,
} from './ingest-sifen-xml.js';
import {
  ReceivedDocumentNotFoundError,
  VersionConflictError,
  type ReceivedDocumentRepository,
} from './ports/received-document-repository.port.js';
import {
  ReceptionQueueUnavailableError,
  type ReceptionJobQueue,
} from './ports/reception-job-queue.port.js';
import type { ParsedSifenDocument, SifenXmlParser } from './ports/sifen-xml-parser.port.js';
import { StorageObjectNotFoundError, type StorageProvider } from './ports/storage-provider.port.js';
import type { TenantFiscalIdentity } from './ports/tenant-fiscal-identity.port.js';
import { toReceivedDocumentFields } from './to-received-document-fields.js';

export interface ReprocessReceivedDocumentDeps {
  readonly repository: ReceivedDocumentRepository;
  readonly storage: StorageProvider;
  readonly parser: SifenXmlParser;
  readonly fiscalIdentity: TenantFiscalIdentity;
  readonly queue: ReceptionJobQueue;
  readonly now: () => Date;
  /**
   * An `extracting` document untouched for this long is taken as stalled (its job died or was
   * failed by BullMQ for stalling too often) and may be reprocessed; a younger one has a live job.
   */
  readonly staleExtractingAfterMs: number;
}

export interface ReprocessReceivedDocumentInput {
  readonly tenantId: string;
  readonly id: string;
  /** API key id (or portal user id) that asked; recorded in the audit entry. */
  readonly actorId: string;
}

export type ReprocessReceivedDocumentResult =
  /** PDF or photo: the extraction job is queued (or already was); the worker does the rest. */
  | { readonly kind: 'queued'; readonly document: ReceivedDocument }
  /** A run is live (or another request won the race); nothing was done. */
  | { readonly kind: 'in_progress'; readonly document: ReceivedDocument }
  /** SIFEN XML: re-read synchronously and now `confirmed` or `needs_review`. */
  | {
      readonly kind: 'reprocessed';
      readonly document: ReceivedDocument;
      readonly events: readonly ReceptionEventType[];
    }
  /** SIFEN XML that is still unreadable; the document is `extraction_failed` with the new code. */
  | {
      readonly kind: 'failed';
      readonly document: ReceivedDocument;
      readonly code: string;
    };

/** The document has no stored artifact (or its bytes are gone): there is nothing to re-run. */
export class ArtifactNotAvailableError extends Error {
  constructor(readonly documentId: string) {
    super(`received document ${documentId} has no stored artifact to reprocess`);
    this.name = 'ArtifactNotAvailableError';
  }
}

/** The status does not allow a reprocess (see {@link createReprocessReceivedDocument}). */
export class ReprocessNotAllowedError extends Error {
  constructor(
    readonly status: ReceivedDocumentStatus,
    readonly source: string,
  ) {
    super(`a ${source} document in status ${status} cannot be reprocessed`);
    this.name = 'ReprocessNotAllowedError';
  }
}

/** Machine code stored on a document recovered from a stalled run. */
export const EXTRACTION_STALLED_CODE = 'extraction_stalled';

const PAST_PREVIOUS_JOBS = 2;

/**
 * Re-runs the extraction on the STORED artifact, never on a new upload (reception R5.8).
 *
 * Allowed from `received` (the queue failed after the upload), `extraction_failed` and a stalled
 * `extracting` (untouched for `staleExtractingAfterMs`: it is first moved to `extraction_failed`,
 * silently, because its job is gone). A live `extracting` run is a no-op. `needs_review` and
 * `confirmed` are refused ({@link ReprocessNotAllowedError}): the state machine has no way back to
 * `extracting`, and re-extracting would overwrite the machine output a person may have corrected.
 *
 * - PDF and photo: the request changes no state; it enqueues the extraction job (the worker
 *   claims `received` or `extraction_failed` and bumps the version). The job id derives from the
 *   document's attempt counter plus {@link PAST_PREVIOUS_JOBS}, so it never reuses an earlier job
 *   id and a double click queues one job.
 * - SIFEN XML: only an unreadable one (`extraction_failed`) is re-read, synchronously, from the
 *   stored bytes; a parsed XML would read the same, so it is refused.
 *
 * One audit entry is appended per accepted request that did work.
 */
export function createReprocessReceivedDocument(deps: ReprocessReceivedDocumentDeps) {
  const { repository } = deps;

  return async function reprocessReceivedDocument(
    input: ReprocessReceivedDocumentInput,
  ): Promise<ReprocessReceivedDocumentResult> {
    const { tenantId, id, actorId } = input;
    const graph = await repository.load(tenantId, id);
    if (graph === null) throw new ReceivedDocumentNotFoundError(id);
    const { artifact } = graph;
    if (artifact === null) throw new ArtifactNotAvailableError(id);
    const source = graph.document.source;
    const isXml = source === 'sifen_xml';

    let document = graph.document;
    if (document.status === 'extracting') {
      const age = deps.now().getTime() - graph.updatedAt.getTime();
      if (age < deps.staleExtractingAfterMs) return { kind: 'in_progress', document };
      const recovered = await recoverStalled(tenantId, document);
      if (recovered === null) return { kind: 'in_progress', document };
      document = recovered;
    } else if (
      document.status !== 'extraction_failed' &&
      (document.status !== 'received' || isXml)
    ) {
      throw new ReprocessNotAllowedError(document.status, source);
    }

    let bytes: Uint8Array | null;
    try {
      bytes = isXml ? await deps.storage.download(artifact.storageKey) : null;
      if (!isXml && !(await deps.storage.exists(artifact.storageKey))) {
        throw new StorageObjectNotFoundError(artifact.storageKey);
      }
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) throw new ArtifactNotAvailableError(id);
      throw error;
    }

    const before = { status: document.status, version: document.version };
    if (bytes === null) {
      try {
        await deps.queue.enqueueExtraction({
          tenantId,
          documentId: id,
          attempt: document.extractionAttempts + PAST_PREVIOUS_JOBS,
        });
      } catch (error) {
        if (error instanceof ReceptionQueueUnavailableError) throw error;
        throw new ReceptionQueueUnavailableError('enqueue failed');
      }
      await repository.appendAudit(tenantId, {
        documentId: id,
        actorId,
        action: 'received_document.reprocess_requested',
        before,
        after: { ...before, queued: true },
      });
      return { kind: 'queued', document };
    }
    return reprocessXml(tenantId, actorId, document, bytes);
  };

  /** `extracting -> extraction_failed` without events; null when another writer got there first. */
  async function recoverStalled(
    tenantId: string,
    extracting: ReceivedDocument,
  ): Promise<ReceivedDocument | null> {
    const failed = transitionReceivedDocument(extracting, 'extraction_failed', {
      at: deps.now(),
    }).document;
    try {
      await repository.save(tenantId, failed, extracting.version, {
        header: { extractionErrorCode: EXTRACTION_STALLED_CODE },
      });
    } catch (error) {
      if (error instanceof VersionConflictError) return null;
      throw error;
    }
    return failed;
  }

  async function reprocessXml(
    tenantId: string,
    actorId: string,
    failed: ReceivedDocument,
    bytes: Uint8Array,
  ): Promise<ReprocessReceivedDocumentResult> {
    const at = deps.now();
    const before = { status: failed.status, version: failed.version };
    const extracting = transitionReceivedDocument(failed, 'extracting', { at }).document;
    try {
      await repository.save(tenantId, extracting, failed.version);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return { kind: 'in_progress', document: failed };
      }
      throw error;
    }

    const audit = async (action: string, result: ReceivedDocument) =>
      repository.appendAudit(tenantId, {
        documentId: failed.id,
        actorId,
        action,
        before,
        after: { status: result.status, version: result.version },
      });
    const fail = async (code: string): Promise<ReprocessReceivedDocumentResult> => {
      const result = transitionReceivedDocument(extracting, 'extraction_failed', { at });
      await repository.save(tenantId, result.document, extracting.version, {
        header: { extractionErrorCode: code },
        ...(result.event === null ? {} : { events: { types: [result.event], at } }),
      });
      await audit('received_document.reprocessed', result.document);
      return { kind: 'failed', document: result.document, code };
    };

    let parsed: ParsedSifenDocument;
    try {
      parsed = deps.parser.parse(bytes);
    } catch (error) {
      const code = sifenXmlFailureCode(error);
      if (code === null) throw error;
      return fail(code);
    }

    const byCdc = await repository.findByCdc(tenantId, parsed.cdc);
    if (byCdc !== null && byCdc.id !== failed.id) return fail('duplicate_document');

    const identity = await deps.fiscalIdentity.getRucIdentity(tenantId);
    const receiverText =
      parsed.receiver.ruc === null || parsed.receiver.dv === null
        ? parsed.receiver.ruc
        : `${parsed.receiver.ruc}-${parsed.receiver.dv}`;
    const isOwnReceiver = identity !== null && matchReceiver(receiverText, identity) === 'match';
    const reasons = validateReceivedDocument(toReceivedDocumentFields(parsed));
    const base = rehydrateReceivedDocument({ ...extracting, isOwnReceiver });
    const extracted = transitionReceivedDocument(base, 'extracted', {
      at,
      confidenceOverall: FULL_CONFIDENCE,
    }).document;
    const final =
      reasons.length === 0
        ? transitionReceivedDocument(extracted, 'confirmed', { at })
        : transitionReceivedDocument(extracted, 'needs_review', { at, reasons });

    await repository.saveExtraction(tenantId, {
      document: final.document,
      expectedVersion: extracting.version,
      header: { ...sifenXmlHeader(parsed), extractionErrorCode: null },
      items: parsed.items.map(sifenXmlItem),
      confidences: CONFIDENCE_FIELDS.map(sifenXmlConfidence),
      ...(final.event === null ? {} : { events: { types: [final.event], at } }),
    });
    await audit('received_document.reprocessed', final.document);
    return {
      kind: 'reprocessed',
      document: final.document,
      events: final.event === null ? [] : [final.event],
    };
  }
}
