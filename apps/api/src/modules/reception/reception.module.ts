import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { IngestSifenXml } from './application/ingest-sifen-xml.js';
import type { StorageProvider } from './application/ports/storage-provider.port.js';
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
  INGEST_SIFEN_XML,
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
  ],
})
export class ReceptionModule {}
