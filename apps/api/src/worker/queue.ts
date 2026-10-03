import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

/** ADR-0013 queue for the per-tenant transmission cycle (sign, assemble, send and poll lotes). */
export const TRANSMISSION_QUEUE = 'lote-build';

/** The job carries only the tenant: Postgres is the source of truth and jobs are rebuildable. */
export interface TransmissionJobData {
  readonly tenantId: string;
}

/** Minimal logger the queue adapters need. */
export interface QueueLogger {
  error(message: string): void;
}

/**
 * BullMQ and ioredis emit `error` for connection trouble; with no listener Node would crash the
 * process on a Redis blip. Logs the class and the system code only: messages carry hosts and URLs.
 */
export function logQueueErrors(
  emitter: Pick<NodeJS.EventEmitter, 'on'>,
  label: string,
  logger: QueueLogger,
): void {
  emitter.on('error', (error: unknown) => {
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    const detail =
      error instanceof Error
        ? `${error.name}${typeof code === 'string' ? ` (${code})` : ''}`
        : 'unknown error';
    logger.error(`${label} error: ${detail}`);
  });
}

const SCHEDULER_PREFIX = 'tenant:';

/** BullMQ requires `maxRetriesPerRequest: null` on the connection a Worker blocks on. */
export function createRedisConnection(url: string, logger?: QueueLogger): Redis {
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  if (logger) logQueueErrors(connection, 'redis connection', logger);
  return connection;
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
  readonly logger?: QueueLogger;
}

export function createTransmissionWorker({
  connection,
  concurrency,
  process,
  prefix,
  logger,
}: TransmissionWorkerOptions): Worker<TransmissionJobData> {
  const worker = new Worker<TransmissionJobData>(TRANSMISSION_QUEUE, (job) => process(job.data), {
    connection,
    concurrency,
    ...(prefix === undefined ? {} : { prefix }),
  });
  if (logger) logQueueErrors(worker, 'transmission worker', logger);
  return worker;
}

/** The `lote-build` queue, with its errors routed to the logger. */
export function createTransmissionQueue(
  connection: Redis,
  logger: QueueLogger,
  prefix?: string,
): Queue<TransmissionJobData> {
  const queue = new Queue<TransmissionJobData>(TRANSMISSION_QUEUE, {
    connection,
    ...(prefix === undefined ? {} : { prefix }),
  });
  logQueueErrors(queue, 'transmission queue', logger);
  return queue;
}
