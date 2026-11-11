import {
  ReceptionQueueUnavailableError,
  type ExtractionJob,
  type ReceptionJobQueue,
} from '../../application/ports/reception-job-queue.port.js';

/** BullMQ queue of the asynchronous extraction (a queue name cannot contain a colon). */
export const RECEPTION_EXTRACTION_QUEUE = 'reception-extraction';
export const RECEPTION_EXTRACTION_JOB_NAME = 'extract';

/** The job carries ids only: Postgres and object storage hold the document and its bytes. */
export interface ReceptionExtractionJobData {
  readonly tenantId: string;
  readonly documentId: string;
}

/** The slice of a BullMQ `Queue` the adapter needs, so the library stays out of the signature. */
export interface ReceptionExtractionQueue {
  add(name: string, data: ReceptionExtractionJobData, opts: JobOptions): Promise<unknown>;
  /** Resolves undefined when no job has the id. */
  getJob(jobId: string): Promise<unknown>;
}

interface JobOptions {
  readonly jobId: string;
  readonly attempts: number;
  readonly backoff: { readonly type: 'exponential'; readonly delay: number };
  readonly removeOnComplete: { readonly age: number };
  readonly removeOnFail: number;
}

/**
 * Attempts per job in total (the first run plus two retries). BullMQ stores it in the job options
 * and the processor reads it back as `job.opts.attempts`, so the producer owns the number.
 */
export const RECEPTION_EXTRACTION_ATTEMPTS = 3;
const BACKOFF_DELAY_MS = 30_000;
/** Kept for an hour so a duplicate enqueue right after completion is still a no-op. */
const COMPLETED_RETENTION_SECONDS = 3600;
const FAILED_RETENTION_COUNT = 500;
const DEFAULT_ADD_TIMEOUT_MS = 3000;

export interface BullmqReceptionJobQueueOptions {
  readonly queue: ReceptionExtractionQueue;
  /** Bounds the Redis round trip: an unreachable Redis must not hang the upload request. */
  readonly timeoutMs?: number;
  /** First retry delay; doubles on each further retry. */
  readonly backoffMs?: number;
}

/**
 * `ReceptionJobQueue` over BullMQ. The job id (`reception-extraction:<document>:<attempt>`) makes
 * `add` idempotent: BullMQ ignores an id that already exists. Any failure to reach Redis becomes
 * `ReceptionQueueUnavailableError` carrying the error class only (messages hold hosts and URLs).
 *
 * The timeout races `queue.add` but does not cancel it: a slow-but-alive Redis can answer 503 while
 * the job still lands. That is harmless by design: the document stays `received`, the worker
 * extracts it, and the re-upload the 503 invites carries the same job id (so BullMQ ignores it) or
 * finds the document already processed (`duplicate`, no second LLM call).
 */
export class BullmqReceptionJobQueue implements ReceptionJobQueue {
  private readonly queue: ReceptionExtractionQueue;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;

  constructor(options: BullmqReceptionJobQueueOptions) {
    this.queue = options.queue;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ADD_TIMEOUT_MS;
    this.backoffMs = options.backoffMs ?? BACKOFF_DELAY_MS;
  }

  private async add(job: ExtractionJob, opts: JobOptions): Promise<boolean> {
    const existing = await this.queue.getJob(opts.jobId);
    await this.queue.add(
      RECEPTION_EXTRACTION_JOB_NAME,
      { tenantId: job.tenantId, documentId: job.documentId },
      opts,
    );
    return existing === undefined || existing === null;
  }

  async enqueueExtraction(job: ExtractionJob): Promise<{ readonly enqueued: boolean }> {
    const opts: JobOptions = {
      jobId: `${RECEPTION_EXTRACTION_QUEUE}:${job.documentId}:${String(job.attempt ?? 1)}`,
      attempts: RECEPTION_EXTRACTION_ATTEMPTS,
      backoff: { type: 'exponential', delay: this.backoffMs },
      removeOnComplete: { age: COMPLETED_RETENTION_SECONDS },
      removeOnFail: FAILED_RETENTION_COUNT,
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, this.timeoutMs);
      });
      // BullMQ answers `add` with the existing job for a known id, so the lookup is what tells a
      // new job from a repeat. Two requests racing past the lookup both report `enqueued`, which
      // only costs an extra audit entry: the job itself is still one.
      const enqueued = await Promise.race([this.add(job, opts), timeout]);
      return { enqueued };
    } catch (error) {
      throw new ReceptionQueueUnavailableError(error instanceof Error ? error.name : 'unknown');
    } finally {
      clearTimeout(timer);
    }
  }
}
