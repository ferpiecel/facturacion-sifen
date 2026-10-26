import { assertValidTenantId, type Database } from '@sifen/db';
import { WarnCertificateExpiry } from '../modules/certificates/application/warn-certificate-expiry.js';
import { DEFAULT_ALERT_DAYS } from '../modules/certificates/domain/certificate-expiry.js';
import { createDrizzleCertificateExpiryStore } from '../modules/certificates/infrastructure/drizzle-certificate-expiry-store.js';
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
  /** Certificate expiry thresholds in days (HU-E3-03); defaults to 60, 30 and 7. */
  readonly certificateAlertDays?: readonly number[];
}

/**
 * Runs one watch pass for the job's tenant: the 72 h deadline warnings and the certificate expiry
 * alerts (HU-E3-03), both read-only plus the webhook outbox. They run independently: one failing does
 * not skip the other, and the first failure is rethrown so BullMQ records it. The tenant id is
 * validated before any query is built.
 */
export function createDeadlineWatchProcessor(deps: DeadlineWatchProcessorDeps) {
  return async (job: {
    data: DeadlineWatchJobData;
  }): Promise<{ warned: number; certificateAlerts: number }> => {
    const { tenantId } = job.data;
    assertValidTenantId(tenantId);
    const now = deps.now ?? (() => new Date());
    const [deadlines, certificates] = await Promise.allSettled([
      new WarnTransmissionDeadlines({
        store: createDrizzleDeadlineWarningStore({ db: deps.db, tenantId }),
        now,
      }).run(),
      new WarnCertificateExpiry({
        store: createDrizzleCertificateExpiryStore({ db: deps.db, tenantId }),
        now,
        thresholdsDays: deps.certificateAlertDays ?? DEFAULT_ALERT_DAYS,
      }).run(),
    ]);
    if (deadlines.status === 'rejected') throw deadlines.reason as Error;
    if (certificates.status === 'rejected') throw certificates.reason as Error;
    return { warned: deadlines.value.warned, certificateAlerts: certificates.value.alerted };
  };
}
