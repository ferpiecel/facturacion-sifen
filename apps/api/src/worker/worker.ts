import { randomUUID } from 'node:crypto';
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
  createDeadlineWatchQueue,
  createDocumentEmailQueue,
  createDocumentEmailScheduleStore,
  createDocumentEmailWorker,
  createDeadlineWatchScheduleStore,
  createDeadlineWatchWorker,
  createRedisConnection,
  createTenantScheduleStore,
  createReceptionEkuatiaWorker,
  createReceptionExtractionWorker,
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
import { createDeadlineWatchProcessor } from './deadline-watch.processor.js';
import { createDocumentEmailProcessor } from './document-email.processor.js';
import { createSmtpDocumentMailer } from '../modules/email/infrastructure/adapters/smtp-document-mailer.js';
import { EmailConfigError, loadEmailConfig } from '../modules/email/infrastructure/email-config.js';
import { createGetKude } from '../modules/emission/application/get-kude.js';
import { createDrizzleDocumentReader } from '../modules/emission/infrastructure/drizzle-document-reader.js';
import { PdfkitKudeRenderer } from '../modules/emission/infrastructure/kude/pdfkit-kude-renderer.js';
import {
  createWebhookDeliveryDeps,
  createWebhookDeliveryProcessor,
} from './webhook-delivery.processor.js';
import { createReceptionEkuatiaProcessor } from './reception-ekuatia.processor.js';
import { createReceptionExtractionProcessor } from './reception-extraction.processor.js';
import { EkuatiaCircuitBreaker } from '../modules/reception/application/ekuatia-circuit-breaker.js';
import { EkuatiaSolveQuota } from '../modules/reception/application/ekuatia-solve-quota.js';
import { ExtractReceivedDocument } from '../modules/reception/application/extract-received-document.js';
import { IngestSifenXml } from '../modules/reception/application/ingest-sifen-xml.js';
import { LookupCdcDocument } from '../modules/reception/application/lookup-cdc-document.js';
import { ConfidencePolicy } from '../modules/reception/domain/confidence-policy.js';
import { createAnthropicExtractionLlm } from '../modules/reception/infrastructure/adapters/anthropic-extraction-llm.adapter.js';
import { createDrizzleEkuatiaSolveUsageStore } from '../modules/reception/infrastructure/adapters/drizzle-ekuatia-solve-usage-store.js';
import { EkuatiaHttpClient } from '../modules/reception/infrastructure/adapters/ekuatia-http-client.adapter.js';
import { Libxml2SifenXmlParser } from '../modules/reception/infrastructure/adapters/libxml2-sifen-xml-parser.adapter.js';
import { TwoCaptchaSolver } from '../modules/reception/infrastructure/adapters/two-captcha-solver.adapter.js';
import {
  assertEkuatiaWorkerPrerequisites,
  loadReceptionEkuatiaConfig,
} from '../modules/reception/infrastructure/reception-ekuatia-config.js';
import { createDrizzleReceivedDocumentRepository } from '../modules/reception/infrastructure/adapters/drizzle-received-document-repository.js';
import { createDrizzleTenantFiscalIdentity } from '../modules/reception/infrastructure/adapters/drizzle-tenant-fiscal-identity.js';
import { JsqrQrDecoder } from '../modules/reception/infrastructure/adapters/jsqr-qr-decoder.adapter.js';
import { PdfiumPdfRenderer } from '../modules/reception/infrastructure/adapters/pdfium-pdf-renderer.adapter.js';
import { createS3StorageProvider } from '../modules/reception/infrastructure/adapters/s3-storage-provider.adapter.js';
import { loadReceptionUploadConfig } from '../modules/reception/infrastructure/http/reception-upload-config.js';
import { loadReceptionExtractionConfig } from '../modules/reception/infrastructure/reception-extraction-config.js';
import {
  isStorageUnconfigured,
  loadStorageConfig,
} from '../modules/reception/infrastructure/storage-config.js';
import { createWorkerSifen } from './worker-gateway.js';
import { createDrizzleTenantEnvironment } from '../modules/transmission/infrastructure/drizzle-tenant-environment.js';
import { readFileSync } from 'node:fs';
import { createTelemetryRuntime } from '../modules/telemetry/infrastructure/telemetry-runtime.js';
import { TelemetryConfigError } from '../modules/telemetry/infrastructure/telemetry-config.js';
import { startMetricsServer } from './metrics-server.js';
import { publishPlatformGauges } from './platform-gauges.js';
import { withTelemetry } from './tracing-gateway.js';
import { loadWorkerConfig, WorkerConfigError } from './worker-config.js';

// Worker process entrypoint (ADR-0003: same code as the API, a different entrypoint): wiring of
// env, Postgres, Redis and signals, exercised by the Redis integration job and the manual run in
// the README ("Worker de transmisión"), and excluded from unit coverage in vitest.config.ts.

const RECONCILE_EVERY_MS = 5 * 60_000;
const WEBHOOK_DELIVERY_EVERY_MS = 30_000;
const DOCUMENT_EMAIL_EVERY_MS = 30_000;
const GAUGES_EVERY_MS = 60_000;

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
  // Fails closed at startup (HU-E11-02): production without SMTP settings and without an explicit
  // EMAIL_ENABLED=false never starts.
  const emailConfig = loadEmailConfig(env);
  // Observability (HU-E14-01) is off unless OTEL_ENABLED / METRICS_ENABLED say otherwise.
  const telemetryRuntime = createTelemetryRuntime(env, { defaultServiceName: 'sifen-worker' });
  const { telemetry } = telemetryRuntime;
  const metricsServer = telemetryRuntime.metricsHandler
    ? await startMetricsServer({
        port: telemetryRuntime.config.metricsPort,
        host: telemetryRuntime.config.metricsHost,
        token: telemetryRuntime.config.metricsToken,
        handler: telemetryRuntime.metricsHandler,
      })
    : undefined;

  // Tenant work runs as app_login/app_user under RLS; only the tenant listing uses platform_admin.
  const appHandle = createNodePostgresDatabase(required(env, 'DATABASE_URL'));
  await assertNonPrivilegedSession(appHandle.db);
  const platformHandle = createNodePostgresDatabase(required(env, 'WORKER_PLATFORM_DATABASE_URL'));

  const connection = createRedisConnection(config.redisUrl, logger);
  const queue = createTransmissionQueue(connection, logger);
  const webhookQueue = createWebhookDeliveryQueue(connection, logger);
  const deadlineQueue = createDeadlineWatchQueue(connection, logger);
  const emailQueue = emailConfig.enabled ? createDocumentEmailQueue(connection, logger) : undefined;

  const certificateCache = new CachedCertificateVault(
    createCertificateVault(env, readBoundedFile),
    {
      ttlMs: config.certificateCacheTtlMs,
      maxEntries: config.certificateCacheMaxEntries,
    },
  );
  // One circuit breaker per SIFEN endpoint, shared by every tenant (HU-E6-08). With
  // SIFEN_GATEWAY=soap each tenant calls SIFEN with its own certificate (ADR-0022).
  // The tracing decorator sits under the breaker, so only real SIFEN calls are timed and counted.
  const sifen = createWorkerSifen(env, {
    logger,
    telemetry,
    decorate: (gateway) => withTelemetry(gateway, telemetry),
    readFile: (path) => readFileSync(path, 'utf8'),
    environments: createDrizzleTenantEnvironment(appHandle.db),
    certificates: {
      open: (tenantId, environment) =>
        certificateCache.open(appHandle.db, tenantId, environment, {
          actor: TRANSMISSION_WORKER_ACTOR,
          purpose: 'sifen-mtls',
        }),
    },
  });
  const processor = new TransmissionCycleProcessor({
    lock: createRedisTenantRunLock(connection, { ttlMs: config.lockTtlMs }),
    createCycle: createTenantCycleFactory({
      db: appHandle.db,
      gateway: (tenantId) => sifen.gatewayFor(tenantId),
      sendPausedUntil: () => sifen.sendPausedUntil(),
      certificates: createCertificateSource({
        db: appHandle.db,
        vault: certificateCache,
        actor: TRANSMISSION_WORKER_ACTOR,
      }),
      cscs: createCscSource({ db: appHandle.db, vault: createCscVault(env) }),
      logger,
    }),
    logger,
    telemetry,
  });

  // Webhook delivery needs neither the tenant run lock (the store claims rows with SKIP LOCKED and a
  // lease) nor the simulator guard (it never talks to SIFEN).
  const processWebhooks = createWebhookDeliveryProcessor({
    db: appHandle.db,
    ...createWebhookDeliveryDeps(env),
  });

  // The deadline watch only reads documents and writes the outbox (HU-E6-07): no run lock, no SIFEN.
  const processDeadlineWatch = createDeadlineWatchProcessor({
    db: appHandle.db,
    certificateAlertDays: config.certificateAlertDays,
  });

  // Document emails (HU-E11-02) only read approved documents and talk to SMTP: no run lock, no SIFEN.
  let processEmails: ReturnType<typeof createDocumentEmailProcessor> | undefined;
  if (emailConfig.enabled) {
    const reader = createDrizzleDocumentReader(appHandle.db);
    const renderer = new PdfkitKudeRenderer();
    const kude = createGetKude({ reader, renderer });
    processEmails = createDocumentEmailProcessor({
      db: appHandle.db,
      mailer: createSmtpDocumentMailer(emailConfig),
      getKude: (tenantId, documentId) => kude(tenantId, documentId),
      reader,
      logger,
    });
  } else {
    logger.info('document emails are disabled (EMAIL_ENABLED=false or no SMTP_HOST)');
  }

  // Cross-tenant gauges for the alert rules (HU-E14-01), only when someone scrapes the worker.
  let gaugeTimer: NodeJS.Timeout | undefined;
  if (metricsServer) {
    const publish = () =>
      publishPlatformGauges({ db: platformHandle.db, telemetry }).catch((error: unknown) => {
        logger.warn(
          `platform gauges failed: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
      });
    void publish();
    gaugeTimer = setInterval(() => void publish(), GAUGES_EVERY_MS);
    gaugeTimer.unref();
  }

  // Reception extraction (R5.6): needs object storage for the uploaded bytes. Settings are read once
  // here and invalid values fail the start. Without ANTHROPIC_API_KEY the worker still runs and
  // fails each document with `llm_disabled` (reprocessable later) instead of leaving it `received`.
  const receptionWorker = startReceptionExtraction(env, appHandle.db, connection);
  // Reception lookup by CDC (R6.3): off unless RECEPTION_EKUATIA_ENABLED and TWOCAPTCHA_API_KEY.
  const ekuatiaWorker = startReceptionEkuatia(env, appHandle.db, connection);

  const running = await startTransmissionWorker({
    cycleIntervalMs: config.cycleIntervalMs,
    reconcileEveryMs: RECONCILE_EVERY_MS,
    directory: createDrizzleTenantDirectory(platformHandle.db),
    schedules: createTenantScheduleStore(queue),
    process: guardSimulatorTenants({
      simulator: sifen.simulator,
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
    deadlineWatch: {
      everyMs: config.deadlineWatchIntervalMs,
      schedules: createDeadlineWatchScheduleStore(deadlineQueue),
      createWorker: () =>
        createDeadlineWatchWorker({
          connection,
          concurrency: config.concurrency,
          process: (data) => processDeadlineWatch({ data }),
          logger,
        }),
    },
    ...(emailQueue && processEmails
      ? {
          emails: {
            everyMs: DOCUMENT_EMAIL_EVERY_MS,
            schedules: createDocumentEmailScheduleStore(emailQueue),
            createWorker: () =>
              createDocumentEmailWorker({
                connection,
                // One SMTP account: a single send pass at a time per worker process.
                concurrency: 1,
                process: (data) => processEmails({ data }),
                logger,
              }),
          },
        }
      : {}),
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
        () => {
          clearInterval(gaugeTimer);
          return running.stop();
        },
        () => receptionWorker?.close(),
        () => ekuatiaWorker?.close(),
        // After the cycles stopped: zeroize every cached certificate and cancel the sweep timer.
        () => {
          certificateCache.clear();
          return Promise.resolve();
        },
        () =>
          Promise.all([
            queue.close(),
            webhookQueue.close(),
            deadlineQueue.close(),
            emailQueue?.close(),
          ]),
        () => connection.quit(),
        () => Promise.all([appHandle.close(), platformHandle.close()]),
        () => metricsServer?.close(),
        () => telemetryRuntime.shutdown(),
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

function startReceptionExtraction(
  env: NodeJS.ProcessEnv,
  db: Parameters<typeof createDrizzleReceivedDocumentRepository>[0],
  connection: ReturnType<typeof createRedisConnection>,
): { close(): Promise<void> } | undefined {
  if (isStorageUnconfigured(env)) {
    logger.info('reception extraction is off (object storage is not configured)');
    return undefined;
  }
  const storage = loadStorageConfig(env, env.NODE_ENV);
  if (storage.status === 'disabled') {
    logger.info('reception extraction is off (object storage is not configured)');
    return undefined;
  }
  const config = loadReceptionExtractionConfig(env);
  const { maxBytes } = loadReceptionUploadConfig(env);
  const extract = new ExtractReceivedDocument({
    repository: createDrizzleReceivedDocumentRepository(db),
    storage: createS3StorageProvider(storage.config),
    pdfRenderer: new PdfiumPdfRenderer({ maxInputBytes: maxBytes }),
    qrDecoder: new JsqrQrDecoder({ maxInputBytes: maxBytes }),
    llm: createAnthropicExtractionLlm(config),
    fiscalIdentity: createDrizzleTenantFiscalIdentity(db),
    policy: ConfidencePolicy.create(config.autoConfirmThreshold),
    now: () => new Date(),
  });
  const worker = createReceptionExtractionWorker({
    connection,
    concurrency: config.concurrency,
    process: createReceptionExtractionProcessor({ extract, logger }),
    logger,
  });
  logger.info(
    `reception extraction worker started (concurrency ${String(config.concurrency)}, ${
      config.apiKey === null ? 'LLM disabled: documents will fail with llm_disabled' : 'LLM enabled'
    })`,
  );
  return worker;
}

function startReceptionEkuatia(
  env: NodeJS.ProcessEnv,
  db: Parameters<typeof createDrizzleReceivedDocumentRepository>[0],
  connection: ReturnType<typeof createRedisConnection>,
): { close(): Promise<void> } | undefined {
  const config = loadReceptionEkuatiaConfig(env);
  if (!config.available || config.solverApiKey === null) {
    logger.info(
      config.enabled
        ? 'reception eKuatia lookup is off (TWOCAPTCHA_API_KEY is not set)'
        : 'reception eKuatia lookup is off (RECEPTION_EKUATIA_ENABLED is not true)',
    );
    return undefined;
  }
  const storage = loadStorageConfig(env, env.NODE_ENV);
  // The API refuses to boot in this state too: never leave accepted lookups without a consumer.
  assertEkuatiaWorkerPrerequisites(config, { objectStorage: storage.status === 'enabled' });
  if (storage.status === 'disabled') return undefined;
  const { maxBytes } = loadReceptionUploadConfig(env);
  const repository = createDrizzleReceivedDocumentRepository(db);
  const parser = new Libxml2SifenXmlParser({ maxBytes });
  const ingestXml = new IngestSifenXml({
    repository,
    storage: createS3StorageProvider(storage.config),
    parser,
    fiscalIdentity: createDrizzleTenantFiscalIdentity(db),
    now: () => new Date(),
    newId: randomUUID,
  });
  const quota = new EkuatiaSolveQuota({
    store: createDrizzleEkuatiaSolveUsageStore(db),
    tenantCap: config.tenantDailySolveCap,
    globalCap: config.globalDailySolveCap,
    now: () => new Date(),
    log: () => undefined, // the worker only gives slots back; the API logs reservations
  });
  const lookup = new LookupCdcDocument({
    enabled: config.enabled,
    repository,
    quota,
    breaker: new EkuatiaCircuitBreaker({
      failureThreshold: config.breakerFailureThreshold,
      cooldownMs: config.breakerCooldownMs,
      now: () => new Date(),
    }),
    solver: new TwoCaptchaSolver({ apiKey: config.solverApiKey }),
    client: new EkuatiaHttpClient({ baseUrl: config.baseUrl }),
    parser,
    ingestXml,
    sitekey: config.sitekey,
    pageUrl: `${config.baseUrl}/consultas/`,
  });
  const worker = createReceptionEkuatiaWorker({
    connection,
    process: createReceptionEkuatiaProcessor({ lookup, logger }),
    logger,
  });
  logger.info(
    `reception eKuatia lookup worker started (caps per UTC day: tenant ${String(config.tenantDailySolveCap)}, global ${String(config.globalDailySolveCap)})`,
  );
  return worker;
}

const isMainModule =
  process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href;
if (isMainModule) {
  main(process.env).catch((error: unknown) => {
    // Only the class and, for config errors, the fixed message (variable names, never values): URLs and keys never reach the log.
    const detail =
      error instanceof WorkerConfigError ||
      error instanceof EmailConfigError ||
      error instanceof TelemetryConfigError
        ? `: ${error.message}`
        : '';
    logger.error(
      `transmission worker failed to start (${error instanceof Error ? error.name : 'unknown error'})${detail}`,
    );
    process.exitCode = 1;
  });
}
