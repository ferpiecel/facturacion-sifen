import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { PortalAuthModule } from '../identity/portal-auth.module.js';
import { createGetKude } from '../emission/application/get-kude.js';
import { PdfkitKudeRenderer } from '../emission/infrastructure/kude/pdfkit-kude-renderer.js';
import { createGetPortalDocument, createGetPortalXml } from './application/get-portal-document.js';
import { createListPortalDocuments } from './application/list-portal-documents.js';
import { PortalDocumentsController } from './infrastructure/portal-documents.controller.js';
import { SqlPortalDocumentSource } from './infrastructure/sql-portal-document-source.js';
import {
  GET_PORTAL_DOCUMENT,
  GET_PORTAL_KUDE,
  GET_PORTAL_XML,
  LIST_PORTAL_DOCUMENTS,
} from './portal-documents.tokens.js';

function portalProvider(token: symbol, build: (source: SqlPortalDocumentSource) => unknown) {
  return {
    provide: token,
    useFactory: (db: Database | null) =>
      db
        ? build(new SqlPortalDocumentSource(db))
        : () => Promise.reject(new ServiceUnavailableException()),
    inject: [DATABASE],
  };
}

/** HU-E12-01/02. Without a `DATABASE` the app still boots and the routes answer 503. */
@Module({
  imports: [PortalAuthModule],
  controllers: [PortalDocumentsController],
  providers: [
    portalProvider(LIST_PORTAL_DOCUMENTS, (source) => createListPortalDocuments({ source })),
    portalProvider(GET_PORTAL_DOCUMENT, (source) => createGetPortalDocument({ source })),
    portalProvider(GET_PORTAL_XML, (source) => createGetPortalXml({ source })),
    portalProvider(GET_PORTAL_KUDE, (source) =>
      createGetKude({ reader: source, renderer: new PdfkitKudeRenderer() }),
    ),
  ],
})
export class PortalDocumentsModule {}
