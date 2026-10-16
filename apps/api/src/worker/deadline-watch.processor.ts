import { assertValidTenantId, type Database } from '@sifen/db';
import { WarnTransmissionDeadlines } from '../modules/transmission/application/warn-transmission-deadlines.js';
import { createDrizzleDeadlineWarningStore } from '../modules/transmission/infrastructure/drizzle-deadline-warning-store.js';

/**
 * Deadline watch job wiring (HU-E6-07, ADR-0008). Free of `bullmq` like the webhook delivery one:
 * `queue.ts` owns the Queue/Worker and `startTransmissionWorker` reconciles one repeatable
 * `deadlineWatchJob(tenantId)` per active tenant.
 */
export const DEADLINE_WATCH_QUEUE = 'deadline-watch';
const JOB_NAME = 'watch';
export const DEFAULT_DEADLINE_WATCH_EVERY_MS = 300_000;

export interface DeadlineWatchJobData {
  readonly tenantId: string;
}

/** Repeatable per-tenant job; the `jobId` keeps re-registering it at every boot from duplicating it. */
export function deadlineWatchJob(tenantId: string, everyMs = DEFAULT_DEADLINE_WATCH_EVERY_MS) {
  return {
    name: JOB_NAME,
    data: { tenantId } satisfies DeadlineWatchJobData,
    opts: {
      repeat: { every: everyMs },
      jobId: `deadline-watch:${tenantId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  };
}

export interface DeadlineWatchProcessorDeps {
  readonly db: Database;
  readonly now?: () => Date;
}

/** Runs one watch pass for the job's tenant. The tenant id is validated before any query is built. */
export function createDeadlineWatchProcessor(deps: DeadlineWatchProcessorDeps) {
  return async (job: { data: DeadlineWatchJobData }): Promise<{ warned: number }> => {
    const { tenantId } = job.data;
    assertValidTenantId(tenantId);
    return new WarnTransmissionDeadlines({
      store: createDrizzleDeadlineWarningStore({ db: deps.db, tenantId }),
      now: deps.now ?? (() => new Date()),
    }).run();
  };
}
