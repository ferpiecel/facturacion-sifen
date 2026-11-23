import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type {
  EkuatiaLookupJob,
  EkuatiaLookupQueue,
} from '../../application/ports/ekuatia-lookup-queue.port.js';
import { ReceptionQueueUnavailableError } from '../../application/ports/reception-job-queue.port.js';
import {
  BullmqEkuatiaLookupQueue,
  RECEPTION_EKUATIA_LOOKUP_QUEUE,
} from './bullmq-ekuatia-lookup-queue.adapter.js';
import { createThrottledErrorLog } from './reception-job-queue-factory.js';

export interface ClosableEkuatiaLookupQueue extends EkuatiaLookupQueue {
  close(): Promise<void>;
}

const ERROR_LOG_INTERVAL_MS = 60_000;

/** Without Redis there is no lookup queue: the lookup answers 503, everything else keeps working. */
const unavailable: ClosableEkuatiaLookupQueue = {
  enqueueLookup: () => Promise.reject(new ReceptionQueueUnavailableError('not_configured')),
  close: () => Promise.resolve(),
};

/**
 * The API-side producer of the lookup queue; same stance as `createReceptionJobQueue`: `REDIS_URL`
 * is optional, an invalid value fails the boot, and the connection opens on the first job.
 */
export function createEkuatiaLookupQueue(
  env: Readonly<Record<string, string | undefined>>,
): ClosableEkuatiaLookupQueue {
  const url = env.REDIS_URL?.trim();
  if (url === undefined || url === '') return unavailable;
  if (!/^rediss?:\/\//.test(url)) {
    throw new Error('REDIS_URL must be a redis:// or rediss:// URL');
  }
  let opened: { connection: Redis; queue: Queue; adapter: BullmqEkuatiaLookupQueue } | undefined;
  const open = () => {
    if (opened) return opened;
    const connection = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    connection.on(
      'error',
      createThrottledErrorLog(
        (line) => {
          console.error(line);
        },
        ERROR_LOG_INTERVAL_MS,
        Date.now,
      ),
    );
    const queue = new Queue(RECEPTION_EKUATIA_LOOKUP_QUEUE, { connection });
    queue.on('error', () => undefined);
    opened = { connection, queue, adapter: new BullmqEkuatiaLookupQueue({ queue }) };
    return opened;
  };
  return {
    enqueueLookup: (job: EkuatiaLookupJob) => open().adapter.enqueueLookup(job),
    async close() {
      if (!opened) return;
      const { queue, connection } = opened;
      opened = undefined;
      await queue.close().catch(() => undefined);
      connection.disconnect();
    },
  };
}
