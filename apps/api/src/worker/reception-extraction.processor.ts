import { assertValidTenantId } from '@sifen/db';
import type {
  ExtractReceivedDocumentInput,
  ExtractReceivedDocumentResult,
} from '../modules/reception/application/extract-received-document.js';
import type { ReceptionExtractionJobData } from '../modules/reception/infrastructure/adapters/bullmq-reception-job-queue.adapter.js';

/**
 * Reception extraction job wiring (R5.6, queue `reception-extraction`). Free of `bullmq`, like the
 * other processors: `worker.ts` owns the Worker bootstrap. The queue name lives with the producer.
 */
export { RECEPTION_EXTRACTION_QUEUE } from '../modules/reception/infrastructure/adapters/bullmq-reception-job-queue.adapter.js';
export type { ReceptionExtractionJobData };

/** Thrown for a failure worth retrying; BullMQ then retries the job with its backoff. */
export class ReceptionExtractionRetryableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReceptionExtractionRetryableError';
  }
}

export interface ReceptionExtractionJob {
  readonly data: ReceptionExtractionJobData;
  /** Runs already made (a stalled rerun does not count here); the current run is `attemptsMade + 1`. */
  readonly attemptsMade: number;
  /**
   * Times BullMQ found this job stalled (its worker died or lost the lock) and put it back in the
   * queue. That requeue does NOT increment `attemptsMade`, so it is counted separately.
   */
  readonly stalledCounter?: number;
  readonly opts: { readonly attempts?: number };
}

export interface ReceptionExtractionProcessorDeps {
  readonly extract: {
    execute(input: ExtractReceivedDocumentInput): Promise<ExtractReceivedDocumentResult>;
    /** Marks a document the final attempt could not finish as `extraction_failed`. */
    failUnexpected(input: { tenantId: string; documentId: string }): Promise<void>;
  };
  /** Ids, counts and error names only: never document content, keys or prompts. */
  readonly logger?: { info(message: string): void; warn(message: string): void };
}

export interface ReceptionExtractionOutcome {
  readonly outcome: string;
}

/**
 * Runs the extraction of one document. The tenant id is validated before anything else; the use
 * case restores the tenant context itself because every repository call opens its own tenant
 * transaction. Outcome mapping: extracted, skipped and non-retryable failures complete the job
 * (a failed document is already `extraction_failed` in the database and must not loop); a
 * retryable failure throws so BullMQ retries it with exponential backoff. `retryAfterSeconds` of a
 * rate-limited provider is only logged: the backoff (`BACKOFF_DELAY_MS` in the queue adapter)
 * already exceeds typical retry-after values.
 *
 * Attempt numbering: the use case resumes a document found in `extracting` only when `attempt > 1`.
 * A job whose worker died is requeued by BullMQ as stalled WITHOUT incrementing `attemptsMade`, so
 * the `attempt` handed to the use case is `attemptsMade + stalledCounter + 1`: a stalled rerun
 * resumes instead of being skipped as `in_progress` forever. Finality (`finalAttempt`) reads real
 * attempts only, so a stall never makes the failure webhook fire early.
 *
 * An unexpected exception on the FINAL attempt would leave the document in `extracting` with no
 * event; the processor then calls `failUnexpected` (stable code `internal_error`, no error text)
 * and rethrows the original error, so the BullMQ job ends as failed (truthful) while the document
 * is `extraction_failed` and reprocessable. Earlier attempts just rethrow and BullMQ retries.
 */
export function createReceptionExtractionProcessor(deps: ReceptionExtractionProcessorDeps) {
  return async (job: ReceptionExtractionJob): Promise<ReceptionExtractionOutcome> => {
    const { tenantId, documentId } = job.data;
    assertValidTenantId(tenantId);
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const attempt = job.attemptsMade + (job.stalledCounter ?? 0) + 1;
    let result: ExtractReceivedDocumentResult;
    try {
      result = await deps.extract.execute({ tenantId, documentId, attempt, finalAttempt });
    } catch (error) {
      if (finalAttempt) await failFinal(deps, tenantId, documentId);
      throw error;
    }
    switch (result.kind) {
      case 'extracted':
        deps.logger?.info(
          `reception extraction ${documentId}: ${result.status} (events=${String(result.events.length)})`,
        );
        return { outcome: `extracted:${result.status}` };
      case 'skipped':
        deps.logger?.info(`reception extraction ${documentId}: skipped (${result.reason})`);
        return { outcome: `skipped:${result.reason}` };
      case 'failed': {
        const detail = `reception extraction ${documentId}: failed ${result.code} attempt=${String(attempt)} retryable=${String(result.retryable)}${
          result.retryAfterSeconds === null
            ? ''
            : ` retryAfterSeconds=${String(result.retryAfterSeconds)}`
        }${result.cause instanceof Error ? ` cause=${result.cause.name}` : ''}`;
        deps.logger?.warn(detail);
        if (result.retryable) throw new ReceptionExtractionRetryableError(result.code);
        return { outcome: `failed:${result.code}` };
      }
    }
  };
}

async function failFinal(
  deps: ReceptionExtractionProcessorDeps,
  tenantId: string,
  documentId: string,
): Promise<void> {
  try {
    await deps.extract.failUnexpected({ tenantId, documentId });
    deps.logger?.warn(`reception extraction ${documentId}: failed internal_error (final attempt)`);
  } catch (error) {
    // The original error still propagates; the document may stay in `extracting` for a manual reprocess.
    deps.logger?.warn(
      `reception extraction ${documentId}: could not mark the document failed${
        error instanceof Error ? ` cause=${error.name}` : ''
      }`,
    );
  }
}
