import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  DEADLINE_WATCH_QUEUE,
  deadlineWatchJob,
  type DeadlineWatchJobData,
} from './deadline-watch.processor.js';
import {
  DOCUMENT_EMAIL_QUEUE,
  documentEmailJob,
  type DocumentEmailJobData,
} from './document-email.processor.js';
import {
  WEBHOOK_DELIVERY_QUEUE,
  webhookDeliveryJob,
  type WebhookDeliveryJobData,
} from './webhook-delivery.processor.js';

/** ADR-0013 queue for the per-tenant transmission cycle (sign, assemble, send and poll lotes). */
export const TRANSMISSION_QUEUE = 'lote-build';

/** The job carries only the tenant: Postgres is the source of truth and jobs are rebuildable. */
export interface TransmissionJobData {
  readonly tenantId: string;
  /** Optional W3C trace context of the producer; without it each cycle starts a root trace. */
  readonly traceparent?: string;
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

/** What a tenant's repeatable job is called and carries; the cadence and retention are common. */
type TenantJob = (tenantId: string) => { name: string; data: TransmissionJobData };

const transmissionJob: TenantJob = (tenantId) => ({
  name: 'transmission-cycle',
  data: { tenantId },
});

export function createTenantScheduleStore(
  queue: ScheduleQueue,
  job: TenantJob = transmissionJob,
): TenantScheduleStore {
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
          ...job(tenantId),
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

const webhookJob: TenantJob = (tenantId) => {
  const { name, data } = webhookDeliveryJob(tenantId);
  return { name, data };
};

/** The `webhook-delivery` schedules (HU-E11-01): same per-tenant scheduler keys, on their own queue. */
export function createWebhookScheduleStore(queue: ScheduleQueue): TenantScheduleStore {
  return createTenantScheduleStore(queue, webhookJob);
}

/** The `webhook-delivery` queue, with its errors routed to the logger. */
export function createWebhookDeliveryQueue(
  connection: Redis,
  logger: QueueLogger,
  prefix?: string,
): Queue<WebhookDeliveryJobData> {
  const queue = new Queue<WebhookDeliveryJobData>(WEBHOOK_DELIVERY_QUEUE, {
    connection,
    ...(prefix === undefined ? {} : { prefix }),
  });
  logQueueErrors(queue, 'webhook delivery queue', logger);
  return queue;
}

export interface WebhookDeliveryWorkerOptions {
  readonly connection: Redis;
  readonly concurrency: number;
  readonly process: (data: WebhookDeliveryJobData) => Promise<unknown>;
  readonly prefix?: string;
  readonly logger?: QueueLogger;
}

export function createWebhookDeliveryWorker({
  connection,
  concurrency,
  process,
  prefix,
  logger,
}: WebhookDeliveryWorkerOptions): Worker<WebhookDeliveryJobData> {
  const worker = new Worker<WebhookDeliveryJobData>(
    WEBHOOK_DELIVERY_QUEUE,
    (job) => process(job.data),
    { connection, concurrency, ...(prefix === undefined ? {} : { prefix }) },
  );
  if (logger) logQueueErrors(worker, 'webhook delivery worker', logger);
  return worker;
}

const deadlineJob: TenantJob = (tenantId) => {
  const { name, data } = deadlineWatchJob(tenantId);
  return { name, data };
};

/** The `deadline-watch` schedules (HU-E6-07): same per-tenant scheduler keys, on their own queue. */
export function createDeadlineWatchScheduleStore(queue: ScheduleQueue): TenantScheduleStore {
  return createTenantScheduleStore(queue, deadlineJob);
}

/** The `deadline-watch` queue, with its errors routed to the logger. */
export function createDeadlineWatchQueue(
  connection: Redis,
  logger: QueueLogger,
  prefix?: string,
): Queue<DeadlineWatchJobData> {
  const queue = new Queue<DeadlineWatchJobData>(DEADLINE_WATCH_QUEUE, {
    connection,
    ...(prefix === undefined ? {} : { prefix }),
  });
  logQueueErrors(queue, 'deadline watch queue', logger);
  return queue;
}

export interface DeadlineWatchWorkerOptions {
  readonly connection: Redis;
  readonly concurrency: number;
  readonly process: (data: DeadlineWatchJobData) => Promise<unknown>;
  readonly prefix?: string;
  readonly logger?: QueueLogger;
}

/** The DeadlineWatchWorker (HU-E6-07): runs each tenant's repeatable watch job. */
export function createDeadlineWatchWorker({
  connection,
  concurrency,
  process,
  prefix,
  logger,
}: DeadlineWatchWorkerOptions): Worker<DeadlineWatchJobData> {
  const worker = new Worker<DeadlineWatchJobData>(
    DEADLINE_WATCH_QUEUE,
    (job) => process(job.data),
    {
      connection,
      concurrency,
      ...(prefix === undefined ? {} : { prefix }),
    },
  );
  if (logger) logQueueErrors(worker, 'deadline watch worker', logger);
  return worker;
}

const documentEmailTenantJob: TenantJob = (tenantId) => {
  const { name, data } = documentEmailJob(tenantId);
  return { name, data };
};

/** The `document-email` schedules (HU-E11-02): same per-tenant scheduler keys, on their own queue. */
export function createDocumentEmailScheduleStore(queue: ScheduleQueue): TenantScheduleStore {
  return createTenantScheduleStore(queue, documentEmailTenantJob);
}

/** The `document-email` queue, with its errors routed to the logger. */
export function createDocumentEmailQueue(
  connection: Redis,
  logger: QueueLogger,
  prefix?: string,
): Queue<DocumentEmailJobData> {
  const queue = new Queue<DocumentEmailJobData>(DOCUMENT_EMAIL_QUEUE, {
    connection,
    ...(prefix === undefined ? {} : { prefix }),
  });
  logQueueErrors(queue, 'document email queue', logger);
  return queue;
}

export interface DocumentEmailWorkerOptions {
  readonly connection: Redis;
  readonly concurrency: number;
  readonly process: (data: DocumentEmailJobData) => Promise<unknown>;
  readonly prefix?: string;
  readonly logger?: QueueLogger;
}

/** The DocumentEmailWorker (HU-E11-02): runs each tenant's repeatable send job. */
export function createDocumentEmailWorker({
  connection,
  concurrency,
  process,
  prefix,
  logger,
}: DocumentEmailWorkerOptions): Worker<DocumentEmailJobData> {
  const worker = new Worker<DocumentEmailJobData>(
    DOCUMENT_EMAIL_QUEUE,
    (job) => process(job.data),
    { connection, concurrency, ...(prefix === undefined ? {} : { prefix }) },
  );
  if (logger) logQueueErrors(worker, 'document email worker', logger);
  return worker;
}
