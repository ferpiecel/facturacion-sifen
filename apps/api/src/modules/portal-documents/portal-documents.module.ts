import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { PortalAuthModule } from '../identity/portal-auth.module.js';
import { createGetKude } from '../emission/application/get-kude.js';
import { PdfkitKudeRenderer } from '../emission/infrastructure/kude/pdfkit-kude-renderer.js';
import { createGetPortalDocument, createGetPortalXml } from './application/get-portal-document.js';
import { createGetPortalSummary } from './application/get-portal-summary.js';
import { createListPortalDocuments } from './application/list-portal-documents.js';
import { PortalDocumentsController } from './infrastructure/portal-documents.controller.js';
import { PortalSummaryController } from './infrastructure/portal-summary.controller.js';
import { SqlPortalDocumentSource } from './infrastructure/sql-portal-document-source.js';
import {
  GET_PORTAL_DOCUMENT,
  GET_PORTAL_KUDE,
  GET_PORTAL_SUMMARY,
  GET_PORTAL_XML,
  LIST_PORTAL_DOCUMENTS,
  PORTAL_CLOCK,
} from './portal-documents.tokens.js';
import { SqlPortalSummarySource } from './infrastructure/sql-portal-summary-source.js';

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

/** HU-E12-01/02/03. Without a `DATABASE` the app still boots and the routes answer 503. */
@Module({
  imports: [PortalAuthModule],
  controllers: [PortalDocumentsController, PortalSummaryController],
  providers: [
    { provide: PORTAL_CLOCK, useValue: () => new Date() },
    {
      provide: GET_PORTAL_SUMMARY,
      useFactory: (db: Database | null, now: () => Date) =>
        db
          ? createGetPortalSummary({ source: new SqlPortalSummarySource(db), now })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE, PORTAL_CLOCK],
    },
    portalProvider(LIST_PORTAL_DOCUMENTS, (source) => createListPortalDocuments({ source })),
    portalProvider(GET_PORTAL_DOCUMENT, (source) => createGetPortalDocument({ source })),
    portalProvider(GET_PORTAL_XML, (source) => createGetPortalXml({ source })),
    portalProvider(GET_PORTAL_KUDE, (source) =>
      createGetKude({ reader: source, renderer: new PdfkitKudeRenderer() }),
    ),
  ],
})
export class PortalDocumentsModule {}
