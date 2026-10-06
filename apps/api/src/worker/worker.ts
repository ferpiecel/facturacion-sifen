import { FakeSifenGateway } from '@sifen/sifen-gateway';
import { assertNonPrivilegedSession, createNodePostgresDatabase } from '@sifen/db';
import { readBoundedFile } from '../cli/bounded-file.js';
import { createCertificateVault, createCscVault } from '../cli/ops.js';
import { CachedCertificateVault } from '../modules/certificates/infrastructure/cached-certificate-vault.js';
import { TRANSMISSION_WORKER_ACTOR } from '../modules/transmission/infrastructure/transmission-audit-actor.js';
import {
  createCertificateSource,
  createCscSource,
} from '../modules/emission/infrastructure/signing-sources.js';
import {
  createRedisConnection,
  createTenantScheduleStore,
  createTransmissionQueue,
  createTransmissionWorker,
  createWebhookDeliveryQueue,
  createWebhookDeliveryWorker,
  createWebhookScheduleStore,
} from './queue.js';
import type { TransmissionJobData } from './queue.js';
import { guardSimulatorTenants } from './simulator-guard.js';
import {
  createDrizzleTenantDirectory,
  createDrizzleTenantEnvironments,
} from './tenant-directory.js';
import { createRedisTenantRunLock } from './tenant-run-lock.js';
import { startTransmissionWorker } from './start-transmission-worker.js';
import { createTenantCycleFactory } from './tenant-cycle-factory.js';
import { TransmissionCycleProcessor, type WorkerLogger } from './transmission-cycle-processor.js';
import {
  createWebhookDeliveryDeps,
  createWebhookDeliveryProcessor,
} from './webhook-delivery.processor.js';
import { createWorkerGateway } from './worker-gateway.js';
import { loadWorkerConfig, WorkerConfigError } from './worker-config.js';

// Worker process entrypoint (ADR-0003: same code as the API, a different entrypoint): wiring of
// env, Postgres, Redis and signals, exercised by the Redis integration job and the manual run in
// the README ("Worker de transmisión"), and excluded from unit coverage in vitest.config.ts.

const RECONCILE_EVERY_MS = 5 * 60_000;
const WEBHOOK_DELIVERY_EVERY_MS = 30_000;

const logger: WorkerLogger = {
  info: (message) => {
    console.log(`${new Date().toISOString()} INFO ${message}`);
  },
  warn: (message) => {
    console.warn(`${new Date().toISOString()} WARN ${message}`);
  },
  error: (message) => {
    console.error(`${new Date().toISOString()} ERROR ${message}`);
  },
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new WorkerConfigError(`${name} is required`);
  return value;
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const config = loadWorkerConfig(env);
  const gateway = createWorkerGateway(env);

  // Tenant work runs as app_login/app_user under RLS; only the tenant listing uses platform_admin.
  const appHandle = createNodePostgresDatabase(required(env, 'DATABASE_URL'));
  await assertNonPrivilegedSession(appHandle.db);
  const platformHandle = createNodePostgresDatabase(required(env, 'WORKER_PLATFORM_DATABASE_URL'));

  const connection = createRedisConnection(config.redisUrl, logger);
  const queue = createTransmissionQueue(connection, logger);
  const webhookQueue = createWebhookDeliveryQueue(connection, logger);

  const certificateCache = new CachedCertificateVault(
    createCertificateVault(env, readBoundedFile),
    {
      ttlMs: config.certificateCacheTtlMs,
      maxEntries: config.certificateCacheMaxEntries,
    },
  );
  const processor = new TransmissionCycleProcessor({
    lock: createRedisTenantRunLock(connection, { ttlMs: config.lockTtlMs }),
    createCycle: createTenantCycleFactory({
      db: appHandle.db,
      gateway,
      certificates: createCertificateSource({
        db: appHandle.db,
        vault: certificateCache,
        actor: TRANSMISSION_WORKER_ACTOR,
      }),
      cscs: createCscSource({ db: appHandle.db, vault: createCscVault(env) }),
      logger,
    }),
    logger,
  });

  // Webhook delivery needs neither the tenant run lock (the store claims rows with SKIP LOCKED and a
  // lease) nor the simulator guard (it never talks to SIFEN).
  const processWebhooks = createWebhookDeliveryProcessor({
    db: appHandle.db,
    ...createWebhookDeliveryDeps(env),
  });

  const running = await startTransmissionWorker({
    cycleIntervalMs: config.cycleIntervalMs,
    reconcileEveryMs: RECONCILE_EVERY_MS,
    directory: createDrizzleTenantDirectory(platformHandle.db),
    schedules: createTenantScheduleStore(queue),
    process: guardSimulatorTenants({
      simulator: gateway instanceof FakeSifenGateway,
      environments: createDrizzleTenantEnvironments(platformHandle.db),
      logger,
      process: (data: TransmissionJobData) => processor.process(data),
    }),
    createWorker: (process) =>
      createTransmissionWorker({ connection, concurrency: config.concurrency, process, logger }),
    webhooks: {
      everyMs: WEBHOOK_DELIVERY_EVERY_MS,
      schedules: createWebhookScheduleStore(webhookQueue),
      createWorker: () =>
        createWebhookDeliveryWorker({
          connection,
          concurrency: config.concurrency,
          process: (data) => processWebhooks({ data }),
          logger,
        }),
    },
    logger,
  });
  logger.info(`transmission worker started (cycle every ${String(config.cycleIntervalMs)} ms)`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, finishing the running cycles`);
    // Order worker, queues, connection, databases; a failing step never skips the later ones.
    const closeAll = async () => {
      const steps = [
        () => running.stop(),
        // After the cycles stopped: zeroize every cached certificate and cancel the sweep timer.
        () => {
          certificateCache.clear();
          return Promise.resolve();
        },
        () => Promise.all([queue.close(), webhookQueue.close()]),
        () => connection.quit(),
        () => Promise.all([appHandle.close(), platformHandle.close()]),
      ];
      let first: unknown;
      let failed = false;
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          if (!failed) first = error;
          failed = true;
        }
      }
      if (failed) throw first;
    };
    void closeAll()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        logger.error(`shutdown failed: ${error instanceof Error ? error.name : 'unknown error'}`);
        process.exitCode = 1;
      });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

const isMainModule =
  process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href;
if (isMainModule) {
  main(process.env).catch((error: unknown) => {
    // Only the class and, for config errors, the fixed message: URLs and keys never reach the log.
    const detail = error instanceof WorkerConfigError ? `: ${error.message}` : '';
    logger.error(
      `transmission worker failed to start (${error instanceof Error ? error.name : 'unknown error'})${detail}`,
    );
    process.exitCode = 1;
  });
}
