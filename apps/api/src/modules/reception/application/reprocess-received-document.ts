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
  type ReceivedDocumentAuditEntry,
  type ReceivedDocumentRepository,
} from './ports/received-document-repository.port.js';
import {
  ReceptionQueueUnavailableError,
  type ReceptionJobQueue,
} from './ports/reception-job-queue.port.js';
import type { ParsedSifenDocument, SifenXmlParser } from './ports/sifen-xml-parser.port.js';
import {
  StorageObjectNotFoundError,
  StorageUnavailableError,
  type StorageProvider,
} from './ports/storage-provider.port.js';
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
  /** Who asked; recorded in the audit entry (the HTTP API only has API keys today). */
  readonly actor: ReceivedDocumentAuditEntry['actor'];
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
 * Failure codes the queue retries (`retryable` in `extract-received-document.ts`): a document
 * failed with one of them may still have a delayed BullMQ retry pending.
 */
const RETRYABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'llm_provider_error',
  'llm_rate_limited',
  'internal_error',
]);

/**
 * How long a retryable failure is taken as still awaiting its retry. The queue retries after 30 s
 * and then 60 s of backoff, so five minutes covers both with room for a busy queue; the record
 * keeps no "final" flag, hence this derived window (a final failure just waits it out).
 */
export const RETRY_PENDING_WINDOW_MS = 5 * 60_000;

/**
 * Re-runs the extraction on the STORED artifact, never on a new upload (reception R5.8).
 *
 * Allowed from `received` (the queue failed after the upload, or its job is stuck), `extraction_failed`
 * and a stalled `extracting` (untouched for `staleExtractingAfterMs`: it is first moved to
 * `extraction_failed`, silently, because its job is gone). `needs_review` and `confirmed` are
 * refused ({@link ReprocessNotAllowedError}): the state machine has no way back to `extracting`,
 * and re-extracting would overwrite the machine output a person may have corrected.
 *
 * A vision reprocess must not start a second live job (two jobs spend twice), so it only goes
 * ahead when the original job cannot still be alive: a `received` document must be older than
 * `staleExtractingAfterMs` (its upload job is not merely backlogged) and an `extraction_failed`
 * one with a retryable code must be older than {@link RETRY_PENDING_WINDOW_MS} (no delayed retry
 * is pending). Otherwise the answer is `in_progress`, nothing is done and nothing is audited.
 *
 * - PDF and photo: the request changes no state; it enqueues the extraction job (the worker
 *   claims `received` or `extraction_failed` and bumps the version). The job id derives from the
 *   document's attempt counter plus {@link PAST_PREVIOUS_JOBS}, so it never reuses an earlier job
 *   id and a double click queues one job.
 * - SIFEN XML: only an unreadable one (`extraction_failed`) is re-read, synchronously, from the
 *   stored bytes; a parsed XML would read the same, so it is refused.
 *
 * One audit entry is appended per accepted request that did work (a NEW job, or the XML re-read).
 */
export function createReprocessReceivedDocument(deps: ReprocessReceivedDocumentDeps) {
  const { repository } = deps;

  return async function reprocessReceivedDocument(
    input: ReprocessReceivedDocumentInput,
  ): Promise<ReprocessReceivedDocumentResult> {
    const { tenantId, id, actor } = input;
    const graph = await repository.load(tenantId, id);
    if (graph === null) throw new ReceivedDocumentNotFoundError(id);
    const { artifact } = graph;
    if (artifact === null) throw new ArtifactNotAvailableError(id);
    const loaded = graph.document;
    const isXml = loaded.source === 'sifen_xml';
    // Taken from the document as loaded, so the audit shows a stall recovery made by this request.
    const before = { status: loaded.status, version: loaded.version };
    const age = deps.now().getTime() - graph.updatedAt.getTime();

    let document = loaded;
    if (loaded.status === 'extracting') {
      if (age < deps.staleExtractingAfterMs) return { kind: 'in_progress', document };
      const recovered = await recoverStalled(tenantId, document);
      if (recovered === null) return { kind: 'in_progress', document };
      document = recovered;
    } else if (loaded.status === 'received' && !isXml) {
      if (age < deps.staleExtractingAfterMs) return { kind: 'in_progress', document };
    } else if (loaded.status === 'extraction_failed') {
      const retryMayBePending =
        !isXml &&
        RETRYABLE_FAILURE_CODES.has(graph.header.extractionErrorCode ?? '') &&
        age < RETRY_PENDING_WINDOW_MS;
      if (retryMayBePending) return { kind: 'in_progress', document };
    } else {
      throw new ReprocessNotAllowedError(loaded.status, loaded.source);
    }

    if (isXml) {
      const bytes = await readStored(id, artifact.storageKey, 'download');
      return reprocessXml(tenantId, actor, document, before, bytes);
    }
    await readStored(id, artifact.storageKey, 'exists');
    let enqueued: boolean;
    try {
      ({ enqueued } = await deps.queue.enqueueExtraction({
        tenantId,
        documentId: id,
        attempt: document.extractionAttempts + PAST_PREVIOUS_JOBS,
      }));
    } catch (error) {
      if (error instanceof ReceptionQueueUnavailableError) throw error;
      throw new ReceptionQueueUnavailableError('enqueue failed');
    }
    // A repeated request finds the job already queued: it is a no-op, not a second audit entry.
    if (enqueued) {
      await repository.appendAudit(tenantId, {
        documentId: id,
        actor,
        action: 'received_document.reprocess_requested',
        before,
        after: { status: document.status, version: document.version, queued: true },
      });
    }
    return { kind: 'queued', document };
  };

  /** Reads the stored object; a missing one is `ArtifactNotAvailableError`, any other failure 503. */
  async function readStored(
    id: string,
    key: string,
    how: 'download' | 'exists',
  ): Promise<Uint8Array> {
    try {
      if (how === 'download') return await deps.storage.download(key);
      if (!(await deps.storage.exists(key))) throw new StorageObjectNotFoundError(key);
      return new Uint8Array();
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) throw new ArtifactNotAvailableError(id);
      throw new StorageUnavailableError();
    }
  }

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
    actor: ReceivedDocumentAuditEntry['actor'],
    failed: ReceivedDocument,
    before: { readonly status: string; readonly version: number },
    bytes: Uint8Array,
  ): Promise<ReprocessReceivedDocumentResult> {
    const at = deps.now();
    const extracting = transitionReceivedDocument(failed, 'extracting', { at }).document;
    try {
      await repository.save(tenantId, extracting, failed.version);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return { kind: 'in_progress', document: failed };
      }
      throw error;
    }

    const fail = async (code: string): Promise<ReprocessReceivedDocumentResult> => {
      const result = transitionReceivedDocument(extracting, 'extraction_failed', { at });
      await repository.save(tenantId, result.document, extracting.version, {
        header: { extractionErrorCode: code },
        ...(result.event === null ? {} : { events: { types: [result.event], at } }),
      });
      return { kind: 'failed', document: result.document, code };
    };

    let result: ReprocessReceivedDocumentResult;
    try {
      result = await readXml(tenantId, extracting, at, bytes, fail);
    } catch (error) {
      // Anything that is not an input fault (a dead database, a bug) must not leave the document
      // in `extracting` with no job behind it: fail it with a stable code, then surface the error.
      if (!(error instanceof VersionConflictError)) {
        await fail('internal_error').catch(() => undefined);
      }
      throw error;
    }
    // After the outcome is stored: an audit failure must never rewrite it.
    await repository.appendAudit(tenantId, {
      documentId: failed.id,
      actor,
      action: 'received_document.reprocessed',
      before,
      after: { status: result.document.status, version: result.document.version },
    });
    return result;
  }

  async function readXml(
    tenantId: string,
    extracting: ReceivedDocument,
    at: Date,
    bytes: Uint8Array,
    fail: (code: string) => Promise<ReprocessReceivedDocumentResult>,
  ): Promise<ReprocessReceivedDocumentResult> {
    let parsed: ParsedSifenDocument;
    try {
      parsed = deps.parser.parse(bytes);
    } catch (error) {
      const code = sifenXmlFailureCode(error);
      if (code === null) throw error;
      return fail(code);
    }

    const byCdc = await repository.findByCdc(tenantId, parsed.cdc);
    if (byCdc !== null && byCdc.id !== extracting.id) return fail('duplicate_document');

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
    return {
      kind: 'reprocessed',
      document: final.document,
      events: final.event === null ? [] : [final.event],
    };
  }
}
