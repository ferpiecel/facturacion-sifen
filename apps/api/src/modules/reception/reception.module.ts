import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { createCorrectReceivedDocument } from './application/correct-received-document.js';
import { createGetArtifact, createGetArtifactUrl } from './application/get-artifact.js';
import { createGetReceivedDocument } from './application/get-received-document.js';
import { IngestSifenXml } from './application/ingest-sifen-xml.js';
import { createListReceivedDocuments } from './application/list-received-documents.js';
import type { StorageProvider } from './application/ports/storage-provider.port.js';
import { createDrizzleReceivedDocumentQuery } from './infrastructure/adapters/drizzle-received-document-query.js';
import { createDrizzleReceivedDocumentRepository } from './infrastructure/adapters/drizzle-received-document-repository.js';
import { createDrizzleTenantFiscalIdentity } from './infrastructure/adapters/drizzle-tenant-fiscal-identity.js';
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
  GET_RECEIVED_DOCUMENT,
  GET_RECEPTION_ARTIFACT,
  GET_RECEPTION_ARTIFACT_URL,
  INGEST_SIFEN_XML,
  LIST_RECEIVED_DOCUMENTS,
  RECEPTION_STORAGE,
  RECEPTION_UPLOAD_CONFIG,
} from './reception.tokens.js';

/** Reception bounded context (ADR-0019): intake, extraction and review of received documents. */
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
      provide: CORRECT_RECEIVED_DOCUMENT,
      useFactory: (db: Database | null) =>
        db
          ? createCorrectReceivedDocument({
              repository: createDrizzleReceivedDocumentRepository(db),
              now: () => new Date(),
            })
          : null,
      inject: [DATABASE],
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
export class ReceptionModule {}
