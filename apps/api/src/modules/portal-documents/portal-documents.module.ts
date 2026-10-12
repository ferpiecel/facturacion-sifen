import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { PortalAuthModule } from '../identity/portal-auth.module.js';
import { createListPortalDocuments } from './application/list-portal-documents.js';
import { PortalDocumentsController } from './infrastructure/portal-documents.controller.js';
import { SqlPortalDocumentSource } from './infrastructure/sql-portal-document-source.js';
import { LIST_PORTAL_DOCUMENTS } from './portal-documents.tokens.js';

/** HU-E12-01. Without a `DATABASE` the app still boots and the routes answer 503. */
@Module({
  imports: [PortalAuthModule],
  controllers: [PortalDocumentsController],
  providers: [
    {
      provide: LIST_PORTAL_DOCUMENTS,
      useFactory: (db: Database | null) =>
        db
          ? createListPortalDocuments({ source: new SqlPortalDocumentSource(db) })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
  ],
})
export class PortalDocumentsModule {}
