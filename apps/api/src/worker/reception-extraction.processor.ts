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
  /** Runs already made; the current run is `attemptsMade + 1`. */
  readonly attemptsMade: number;
  readonly opts: { readonly attempts?: number };
}

export interface ReceptionExtractionProcessorDeps {
  readonly extract: {
    execute(input: ExtractReceivedDocumentInput): Promise<ExtractReceivedDocumentResult>;
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
 * rate-limited provider is only logged: the 30 s backoff already exceeds typical retry-after values.
 */
export function createReceptionExtractionProcessor(deps: ReceptionExtractionProcessorDeps) {
  return async (job: ReceptionExtractionJob): Promise<ReceptionExtractionOutcome> => {
    const { tenantId, documentId } = job.data;
    assertValidTenantId(tenantId);
    const attempt = job.attemptsMade + 1;
    const result = await deps.extract.execute({
      tenantId,
      documentId,
      attempt,
      finalAttempt: attempt >= (job.opts.attempts ?? 1),
    });
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
