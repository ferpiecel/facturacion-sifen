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
  const reconcile = (refresh: boolean) =>
    reconcileTenantSchedules({
      directory: deps.directory,
      schedules: deps.schedules,
      everyMs: deps.cycleIntervalMs,
      refresh,
    });

  await reconcile(true);
  const worker = deps.createWorker(deps.process);
  const timer = timers.setInterval(() => {
    reconcile(false).catch((error: unknown) => {
      const kind = error instanceof Error ? error.name : 'unknown error';
      deps.logger.error(`tenant schedule reconcile failed: ${kind}`);
    });
  }, deps.reconcileEveryMs);

  return {
    async stop() {
      timers.clearInterval(timer);
      await worker.close();
    },
  };
}
