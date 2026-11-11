export interface ExtractionJob {
  readonly tenantId: string;
  readonly documentId: string;
  /**
   * Distinguishes a deliberate re-run (reprocess, R5.8) from the first job of a document. The job
   * id derives from the document id (and the attempt when present), so enqueueing the same pair
   * twice never creates two jobs.
   */
  readonly attempt?: number;
}

/** The queue could not take the job (Redis down, timeout). Carries no document content. */
export class ReceptionQueueUnavailableError extends Error {
  constructor(detail: string) {
    super(`reception job queue unavailable: ${detail}`);
    this.name = 'ReceptionQueueUnavailableError';
  }
}

export interface ReceptionJobQueue {
  /**
   * Schedules the asynchronous extraction of a stored document. Idempotent per (document, attempt):
   * a second call while the first job exists is a no-op, never a duplicate job. `enqueued` is false
   * when that job already existed, so callers can tell a new job from a repeated request.
   *
   * @throws ReceptionQueueUnavailableError when the job could not be enqueued.
   */
  enqueueExtraction(job: ExtractionJob): Promise<{ readonly enqueued: boolean }>;
}
