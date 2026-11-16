import { randomUUID } from 'node:crypto';
import { Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { ConfidencePolicy } from './domain/confidence-policy.js';
import {
  loadAutoConfirmThreshold,
  loadExtractionDailyCap,
  loadExtractionStaleAfterMs,
} from './infrastructure/reception-extraction-config.js';
import { ExtractionQuota } from './application/extraction-quota.js';
import { createCorrectReceivedDocument } from './application/correct-received-document.js';
import { createGetArtifact, createGetArtifactUrl } from './application/get-artifact.js';
import { createGetReceivedDocument } from './application/get-received-document.js';
import { IngestSifenXml } from './application/ingest-sifen-xml.js';
import { IngestUpload } from './application/ingest-upload.js';
import { createListReceivedDocuments } from './application/list-received-documents.js';
import { createReprocessReceivedDocument } from './application/reprocess-received-document.js';
import type { StorageProvider } from './application/ports/storage-provider.port.js';
import { createDrizzleExtractionUsageStore } from './infrastructure/adapters/drizzle-extraction-usage-store.js';
import { createDrizzleReceivedDocumentQuery } from './infrastructure/adapters/drizzle-received-document-query.js';
import { createDrizzleReceivedDocumentRepository } from './infrastructure/adapters/drizzle-received-document-repository.js';
import { createDrizzleTenantFiscalIdentity } from './infrastructure/adapters/drizzle-tenant-fiscal-identity.js';
import {
  createReceptionJobQueue,
  type ClosableReceptionJobQueue,
} from './infrastructure/adapters/reception-job-queue-factory.js';
import { Libxml2SifenXmlParser } from './infrastructure/adapters/libxml2-sifen-xml-parser.adapter.js';
import { createS3StorageProvider } from './infrastructure/adapters/s3-storage-provider.adapter.js';
import { ReceivedDocumentsController } from './infrastructure/http/received-documents.controller.js';
import {
  loadReceptionUploadConfig,
  type ReceptionUploadConfig,
} from './infrastructure/http/reception-upload-config.js';
import { loadStorageConfig } from './infrastructure/storage-config.js';
import {
  CORRECT_RECEIVED_DOCUMENT,
  EXTRACTION_QUOTA,
  GET_RECEIVED_DOCUMENT,
  GET_RECEPTION_ARTIFACT,
  GET_RECEPTION_ARTIFACT_URL,
  INGEST_SIFEN_XML,
  INGEST_UPLOAD,
  LIST_RECEIVED_DOCUMENTS,
  RECEPTION_JOB_QUEUE,
  RECEPTION_STORAGE,
  RECEPTION_UPLOAD_CONFIG,
  REPROCESS_RECEIVED_DOCUMENT,
} from './reception.tokens.js';

/** Reception bounded context (ADR-0024): intake, extraction and review of received documents. */
@Module({
  controllers: [ReceivedDocumentsController],
  providers: [
    { provide: RECEPTION_UPLOAD_CONFIG, useFactory: () => loadReceptionUploadConfig(process.env) },
    {
      // `null` when storage is not configured or its settings are invalid: uploads answer 503
      // `storage_unavailable` and `GET /health` reports the problem (same stance as HealthModule).
      provide: RECEPTION_STORAGE,
      useFactory: (): StorageProvider | null => {
        try {
          const storage = loadStorageConfig(process.env, process.env.NODE_ENV);
          return storage.status === 'enabled' ? createS3StorageProvider(storage.config) : null;
        } catch {
          return null;
        }
      },
    },
    {
      // Daily cap of LLM extractions per tenant (R5.9). Logs ids and counts only.
      provide: EXTRACTION_QUOTA,
      useFactory: (db: Database | null) => {
        if (!db) return null;
        const logger = new Logger('ReceptionExtractionQuota');
        return new ExtractionQuota({
          store: createDrizzleExtractionUsageStore(db),
          dailyCap: loadExtractionDailyCap(process.env),
          now: () => new Date(),
          log: (message, fields) => {
            logger.log(`${message} ${JSON.stringify(fields)}`);
          },
        });
      },
      inject: [DATABASE],
    },
    {
      provide: INGEST_SIFEN_XML,
      useFactory: (
        db: Database | null,
        storage: StorageProvider | null,
        upload: ReceptionUploadConfig,
      ) =>
        db && storage
          ? new IngestSifenXml({
              repository: createDrizzleReceivedDocumentRepository(db),
              storage,
              parser: new Libxml2SifenXmlParser({ maxBytes: upload.maxBytes }),
              fiscalIdentity: createDrizzleTenantFiscalIdentity(db),
              now: () => new Date(),
              newId: randomUUID,
            })
          : null,
      inject: [DATABASE, RECEPTION_STORAGE, RECEPTION_UPLOAD_CONFIG],
    },
    {
      // Optional Redis producer: without `REDIS_URL` PDF and photo uploads answer 503
      // `queue_unavailable` while XML uploads keep working (docs/configuracion.md).
      provide: RECEPTION_JOB_QUEUE,
      useFactory: (): ClosableReceptionJobQueue => createReceptionJobQueue(process.env),
    },
    {
      // Single entry point of `POST /v1/received-documents`: XML stays synchronous, PDF and photos
      // are stored, registered and queued for the extraction worker (R5.6).
      provide: INGEST_UPLOAD,
      useFactory: (
        db: Database | null,
        storage: StorageProvider | null,
        ingestXml: IngestSifenXml | null,
        queue: ClosableReceptionJobQueue,
        quota: ExtractionQuota | null,
      ) =>
        db && storage && ingestXml && quota
          ? new IngestUpload({
              quota,
              repository: createDrizzleReceivedDocumentRepository(db),
              storage,
              queue,
              ingestXml,
              newId: randomUUID,
            })
          : null,
      inject: [
        DATABASE,
        RECEPTION_STORAGE,
        INGEST_SIFEN_XML,
        RECEPTION_JOB_QUEUE,
        EXTRACTION_QUOTA,
      ],
    },
    {
      provide: CORRECT_RECEIVED_DOCUMENT,
      useFactory: (db: Database | null) =>
        db
          ? createCorrectReceivedDocument({
              repository: createDrizzleReceivedDocumentRepository(db),
              // Only the threshold: worker-only variables must not stop the API boot.
              policy: ConfidencePolicy.create(loadAutoConfirmThreshold(process.env)),
              now: () => new Date(),
            })
          : null,
      inject: [DATABASE],
    },
    {
      // Re-runs the extraction on the stored artifact (R5.8). Needs storage (to check the bytes),
      // the queue (PDF and photo) and the parser (XML); a missing queue answers 503 per request.
      provide: REPROCESS_RECEIVED_DOCUMENT,
      useFactory: (
        db: Database | null,
        storage: StorageProvider | null,
        queue: ClosableReceptionJobQueue,
        upload: ReceptionUploadConfig,
        quota: ExtractionQuota | null,
      ) =>
        db && storage && quota
          ? createReprocessReceivedDocument({
              quota,
              repository: createDrizzleReceivedDocumentRepository(db),
              storage,
              parser: new Libxml2SifenXmlParser({ maxBytes: upload.maxBytes }),
              fiscalIdentity: createDrizzleTenantFiscalIdentity(db),
              queue,
              now: () => new Date(),
              staleExtractingAfterMs: loadExtractionStaleAfterMs(process.env),
            })
          : null,
      inject: [
        DATABASE,
        RECEPTION_STORAGE,
        RECEPTION_JOB_QUEUE,
        RECEPTION_UPLOAD_CONFIG,
        EXTRACTION_QUOTA,
      ],
    },
    {
      provide: LIST_RECEIVED_DOCUMENTS,
      useFactory: (db: Database | null) =>
        db ? createListReceivedDocuments({ query: createDrizzleReceivedDocumentQuery(db) }) : null,
      inject: [DATABASE],
    },
    {
      provide: GET_RECEIVED_DOCUMENT,
      useFactory: (db: Database | null) =>
        db ? createGetReceivedDocument({ query: createDrizzleReceivedDocumentQuery(db) }) : null,
      inject: [DATABASE],
    },
    {
      // Artifact routes need storage too: `null` answers 503 `storage_unavailable`.
      provide: GET_RECEPTION_ARTIFACT,
      useFactory: (db: Database | null, storage: StorageProvider | null) =>
        db && storage
          ? createGetArtifact({ query: createDrizzleReceivedDocumentQuery(db), storage })
          : null,
      inject: [DATABASE, RECEPTION_STORAGE],
    },
    {
      provide: GET_RECEPTION_ARTIFACT_URL,
      useFactory: (db: Database | null, storage: StorageProvider | null) =>
        db && storage
          ? createGetArtifactUrl({ query: createDrizzleReceivedDocumentQuery(db), storage })
          : null,
      inject: [DATABASE, RECEPTION_STORAGE],
    },
  ],
})
export class ReceptionModule implements OnApplicationShutdown {
  constructor(@Inject(RECEPTION_JOB_QUEUE) private readonly queue: ClosableReceptionJobQueue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
