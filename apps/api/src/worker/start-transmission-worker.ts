import { reconcileTenantSchedules } from './reconcile-tenant-schedules.js';
import type { TenantScheduleStore, TransmissionJobData } from './queue.js';
import type { WorkerLogger } from './transmission-cycle-processor.js';
import type { TenantDirectory } from './tenant-directory.js';

export interface StartTransmissionWorkerDeps {
  readonly cycleIntervalMs: number;
  /** How often tenants created or removed after startup get (or lose) their schedule. */
  readonly reconcileEveryMs: number;
  readonly directory: TenantDirectory;
  readonly schedules: TenantScheduleStore;
  readonly process: (data: TransmissionJobData) => Promise<unknown>;
  readonly createWorker: (process: (data: TransmissionJobData) => Promise<unknown>) => {
    close(): Promise<void>;
  };
  /**
   * Webhook delivery (HU-E11-01): its own queue and worker, scheduled per tenant at its own cadence
   * and reconciled with the same tenant directory.
   */
  readonly webhooks?: {
    readonly everyMs: number;
    readonly schedules: TenantScheduleStore;
    readonly createWorker: () => { close(): Promise<void> };
  };
  readonly logger: WorkerLogger;
  readonly timers?: {
    setInterval(fn: () => void, ms: number): NodeJS.Timeout;
    clearInterval(timer: NodeJS.Timeout): void;
  };
}

export interface RunningTransmissionWorker {
  /** Stops reconciling and waits for the jobs in flight (BullMQ `close`) before resolving. */
  stop(): Promise<void>;
}

/**
 * Schedules a repeatable cycle job per tenant (cadence applied at startup), starts the worker that
 * runs them and keeps the schedules in step with the tenants. A failing periodic reconcile is
 * logged by error class and retried on the next tick; the first one must succeed.
 */
export async function startTransmissionWorker(
  deps: StartTransmissionWorkerDeps,
): Promise<RunningTransmissionWorker> {
  const timers = deps.timers ?? { setInterval, clearInterval };
  const reconcileTransmission = (refresh: boolean) =>
    reconcileTenantSchedules({
      directory: deps.directory,
      schedules: deps.schedules,
      everyMs: deps.cycleIntervalMs,
      refresh,
    });
  // Webhook scheduling never blocks transmission (nor the other way round): its failure is logged
  // by error class and retried on the next tick, also at startup.
  const reconcileWebhooks = async (refresh: boolean) => {
    if (!deps.webhooks) return;
    try {
      await reconcileTenantSchedules({
        directory: deps.directory,
        schedules: deps.webhooks.schedules,
        everyMs: deps.webhooks.everyMs,
        refresh,
      });
    } catch (error: unknown) {
      const kind = error instanceof Error ? error.name : 'unknown error';
      deps.logger.error(`webhook schedule reconcile failed: ${kind}`);
    }
  };
  const reconcile = async (refresh: boolean) => {
    // Sequential so the schedules appear in a predictable order; the webhook step never throws.
    const transmission = await reconcileTransmission(refresh).then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    await reconcileWebhooks(refresh);
    if (transmission) throw transmission.error;
  };

  await reconcile(true);
  const worker = deps.createWorker(deps.process);
  let webhookWorker: { close(): Promise<void> } | undefined;
  try {
    webhookWorker = deps.webhooks?.createWorker();
  } catch (error) {
    await worker.close();
    throw error;
  }
  const timer = timers.setInterval(() => {
    reconcile(false).catch((error: unknown) => {
      const kind = error instanceof Error ? error.name : 'unknown error';
      deps.logger.error(`tenant schedule reconcile failed: ${kind}`);
    });
  }, deps.reconcileEveryMs);

  return {
    async stop() {
      timers.clearInterval(timer);
      // Every close runs even if one fails; the first failure is rethrown afterwards.
      const closes = await Promise.allSettled([worker.close(), webhookWorker?.close()]);
      const failed = closes.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}
