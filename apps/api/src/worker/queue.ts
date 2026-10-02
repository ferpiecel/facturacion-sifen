import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

/** ADR-0013 queue for the per-tenant transmission cycle (sign, assemble, send and poll lotes). */
export const TRANSMISSION_QUEUE = 'lote-build';

/** The job carries only the tenant: Postgres is the source of truth and jobs are rebuildable. */
export interface TransmissionJobData {
  readonly tenantId: string;
}

const SCHEDULER_PREFIX = 'tenant:';

/** BullMQ requires `maxRetriesPerRequest: null` on the connection a Worker blocks on. */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/** One repeatable job scheduler per tenant, keyed by tenant id, so reconciling is idempotent. */
export interface TenantScheduleStore {
  /** Tenant ids that currently have a schedule. */
  list(): Promise<readonly string[]>;
  upsert(tenantId: string, everyMs: number): Promise<void>;
  remove(tenantId: string): Promise<void>;
}

type ScheduleQueue = Pick<
  Queue<TransmissionJobData>,
  'upsertJobScheduler' | 'getJobSchedulers' | 'removeJobScheduler'
>;

export function createTenantScheduleStore(queue: ScheduleQueue): TenantScheduleStore {
  return {
    async list() {
      const schedulers = await queue.getJobSchedulers(0, -1);
      return schedulers
        .map((scheduler) => scheduler.key)
        .filter((key) => key.startsWith(SCHEDULER_PREFIX))
        .map((key) => key.slice(SCHEDULER_PREFIX.length));
    },
    async upsert(tenantId, everyMs) {
      await queue.upsertJobScheduler(
        `${SCHEDULER_PREFIX}${tenantId}`,
        { every: everyMs },
        {
          name: 'transmission-cycle',
          data: { tenantId },
          // Finished jobs are not history worth keeping: the cycle report is logged.
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    },
    async remove(tenantId) {
      await queue.removeJobScheduler(`${SCHEDULER_PREFIX}${tenantId}`);
    },
  };
}

export interface TransmissionWorkerOptions {
  readonly connection: Redis;
  readonly concurrency: number;
  readonly process: (data: TransmissionJobData) => Promise<unknown>;
  readonly prefix?: string;
}

export function createTransmissionWorker({
  connection,
  concurrency,
  process,
  prefix,
}: TransmissionWorkerOptions): Worker<TransmissionJobData> {
  return new Worker<TransmissionJobData>(TRANSMISSION_QUEUE, (job) => process(job.data), {
    connection,
    concurrency,
    ...(prefix === undefined ? {} : { prefix }),
  });
}
