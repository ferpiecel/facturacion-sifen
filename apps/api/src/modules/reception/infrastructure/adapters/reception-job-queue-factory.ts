import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  ReceptionQueueUnavailableError,
  type ExtractionJob,
  type ReceptionJobQueue,
} from '../../application/ports/reception-job-queue.port.js';
import {
  BullmqReceptionJobQueue,
  RECEPTION_EXTRACTION_QUEUE,
} from './bullmq-reception-job-queue.adapter.js';

export interface ClosableReceptionJobQueue extends ReceptionJobQueue {
  close(): Promise<void>;
}

/** Without Redis there is no extraction queue: PDF and photo uploads answer 503, XML keeps working. */
const unavailable: ClosableReceptionJobQueue = {
  enqueueExtraction: () => Promise.reject(new ReceptionQueueUnavailableError('not_configured')),
  close: () => Promise.resolve(),
};

/**
 * The API-side producer of the extraction queue. `REDIS_URL` is optional here (the API does not
 * need Redis for anything else): unset means `unavailable`, an invalid value fails the boot. The
 * connection opens on the first job, with no offline queue and a single retry per command, so an
 * unreachable Redis turns into a quick `ReceptionQueueUnavailableError` instead of a hung request.
 */
export function createReceptionJobQueue(
  env: Readonly<Record<string, string | undefined>>,
): ClosableReceptionJobQueue {
  const url = env.REDIS_URL?.trim();
  if (url === undefined || url === '') return unavailable;
  if (!/^rediss?:\/\//.test(url)) {
    throw new Error('REDIS_URL must be a redis:// or rediss:// URL');
  }
  let opened: { connection: Redis; queue: Queue; adapter: BullmqReceptionJobQueue } | undefined;
  const open = () => {
    if (opened) return opened;
    const connection = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    // Without a listener ioredis would crash the process on a connection error; log the class only.
    connection.on('error', (error: unknown) => {
      console.error(
        `reception queue connection error: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    });
    const queue = new Queue(RECEPTION_EXTRACTION_QUEUE, { connection });
    queue.on('error', () => undefined);
    opened = { connection, queue, adapter: new BullmqReceptionJobQueue({ queue }) };
    return opened;
  };
  return {
    enqueueExtraction: (job: ExtractionJob) => open().adapter.enqueueExtraction(job),
    async close() {
      if (!opened) return;
      const { queue, connection } = opened;
      opened = undefined;
      await queue.close().catch(() => undefined);
      connection.disconnect();
    },
  };
}
