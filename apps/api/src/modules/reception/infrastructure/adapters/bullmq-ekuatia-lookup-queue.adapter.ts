import type {
  EkuatiaLookupJob,
  EkuatiaLookupQueue,
} from '../../application/ports/ekuatia-lookup-queue.port.js';
import { ReceptionQueueUnavailableError } from '../../application/ports/reception-job-queue.port.js';

/** BullMQ queue of the eKuatia lookups by CDC (a queue name cannot contain a colon). */
export const RECEPTION_EKUATIA_LOOKUP_QUEUE = 'reception-ekuatia-lookup';
export const RECEPTION_EKUATIA_LOOKUP_JOB_NAME = 'lookup';

/**
 * One run per job, never an automatic retry: a retry would solve another paid captcha. A failed
 * lookup is requested again by the caller, which takes a new quota slot.
 */
export const RECEPTION_EKUATIA_LOOKUP_ATTEMPTS = 1;

/** The job carries the tenant, the CDC and the quota day: no document exists yet. */
export type EkuatiaLookupJobData = EkuatiaLookupJob;

/** The slice of a BullMQ `Queue` the adapter needs, so the library stays out of the signature. */
export interface EkuatiaLookupBullQueue {
  add(name: string, data: EkuatiaLookupJobData, opts: JobOptions): Promise<unknown>;
  /** Resolves undefined when no job has the id. */
  getJob(jobId: string): Promise<unknown>;
}

interface JobOptions {
  readonly jobId: string;
  readonly attempts: number;
  readonly removeOnComplete: true;
  readonly removeOnFail: true;
}

const DEFAULT_ADD_TIMEOUT_MS = 3000;

export interface BullmqEkuatiaLookupQueueOptions {
  readonly queue: EkuatiaLookupBullQueue;
  /** Bounds the Redis round trip: an unreachable Redis must not hang the request. */
  readonly timeoutMs?: number;
}

/**
 * `EkuatiaLookupQueue` over BullMQ. The job id (`reception-ekuatia-lookup:<tenant>:<cdc>`) makes
 * `add` idempotent while a job for that CDC is waiting or running, so two concurrent requests for
 * the same CDC solve one captcha. Finished jobs are removed (success and failure), so a failed
 * lookup can be requested again instead of being swallowed by a stale id. Any failure to reach
 * Redis becomes `ReceptionQueueUnavailableError` carrying the error class only.
 */
export class BullmqEkuatiaLookupQueue implements EkuatiaLookupQueue {
  private readonly queue: EkuatiaLookupBullQueue;
  private readonly timeoutMs: number;

  constructor(options: BullmqEkuatiaLookupQueueOptions) {
    this.queue = options.queue;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ADD_TIMEOUT_MS;
  }

  private async add(job: EkuatiaLookupJob): Promise<boolean> {
    const jobId = `${RECEPTION_EKUATIA_LOOKUP_QUEUE}:${job.tenantId}:${job.cdc}`;
    const existing = await this.queue.getJob(jobId);
    await this.queue.add(
      RECEPTION_EKUATIA_LOOKUP_JOB_NAME,
      { tenantId: job.tenantId, cdc: job.cdc, usageDate: job.usageDate },
      {
        jobId,
        attempts: RECEPTION_EKUATIA_LOOKUP_ATTEMPTS,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return existing === undefined || existing === null;
  }

  async enqueueLookup(job: EkuatiaLookupJob): Promise<{ readonly enqueued: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, this.timeoutMs);
      });
      return { enqueued: await Promise.race([this.add(job), timeout]) };
    } catch (error) {
      throw new ReceptionQueueUnavailableError(error instanceof Error ? error.name : 'unknown');
    } finally {
      clearTimeout(timer);
    }
  }
}
