import { Queue } from 'bullmq';
import { assertNonPrivilegedSession, createNodePostgresDatabase } from '@sifen/db';
import { readBoundedFile } from '../cli/bounded-file.js';
import { createCertificateVault, createCscVault } from '../cli/ops.js';
import {
  createCertificateSource,
  createCscSource,
} from '../modules/emission/infrastructure/signing-sources.js';
import {
  createRedisConnection,
  createTenantScheduleStore,
  createTransmissionWorker,
  TRANSMISSION_QUEUE,
} from './queue.js';
import { createDrizzleTenantDirectory } from './tenant-directory.js';
import { createRedisTenantRunLock } from './tenant-run-lock.js';
import { startTransmissionWorker } from './start-transmission-worker.js';
import { createTenantCycleFactory } from './tenant-cycle-factory.js';
import { TransmissionCycleProcessor, type WorkerLogger } from './transmission-cycle-processor.js';
import { createWorkerGateway } from './worker-gateway.js';
import { loadWorkerConfig, WorkerConfigError } from './worker-config.js';

// Worker process entrypoint (ADR-0003: same code as the API, a different entrypoint): wiring of
// env, Postgres, Redis and signals, exercised by the Redis integration job and the manual run in
// the README ("Worker de transmisión"), and excluded from unit coverage in vitest.config.ts.

const RECONCILE_EVERY_MS = 5 * 60_000;

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

  const connection = createRedisConnection(config.redisUrl);
  const queue = new Queue(TRANSMISSION_QUEUE, { connection });

  const processor = new TransmissionCycleProcessor({
    lock: createRedisTenantRunLock(connection, { ttlMs: config.lockTtlMs }),
    createCycle: createTenantCycleFactory({
      db: appHandle.db,
      gateway,
      certificates: createCertificateSource({
        db: appHandle.db,
        vault: createCertificateVault(env, readBoundedFile),
      }),
      cscs: createCscSource({ db: appHandle.db, vault: createCscVault(env) }),
      logger,
    }),
    logger,
  });

  const running = await startTransmissionWorker({
    cycleIntervalMs: config.cycleIntervalMs,
    reconcileEveryMs: RECONCILE_EVERY_MS,
    directory: createDrizzleTenantDirectory(platformHandle.db),
    schedules: createTenantScheduleStore(queue),
    process: (data) => processor.process(data),
    createWorker: (process) =>
      createTransmissionWorker({ connection, concurrency: config.concurrency, process }),
    logger,
  });
  logger.info(`transmission worker started (cycle every ${String(config.cycleIntervalMs)} ms)`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, finishing the running cycles`);
    void running
      .stop()
      .then(() => queue.close())
      .then(() => connection.quit())
      .then(() => Promise.all([appHandle.close(), platformHandle.close()]))
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
