import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { createAcceptCreditNote } from './application/accept-credit-note.js';
import { createAcceptInvoice } from './application/accept-invoice.js';
import { createGetDocument } from './application/get-document.js';
import { createGetKude } from './application/get-kude.js';
import { emissionValidationConfig } from './emission-validation-config.js';
import {
  ACCEPT_CREDIT_NOTE,
  ACCEPT_INVOICE,
  CREDIT_NOTES_ENABLED,
  GET_DOCUMENT,
  GET_KUDE,
} from './emission.tokens.js';
import { createDrizzleAcceptanceUnitOfWork } from './infrastructure/drizzle-acceptance-unit-of-work.js';
import { createDrizzleDocumentReader } from './infrastructure/drizzle-document-reader.js';
import { PdfkitKudeRenderer } from './infrastructure/kude/pdfkit-kude-renderer.js';
import { DocumentQueryController } from './infrastructure/http/document-query.controller.js';
import { DocumentsController } from './infrastructure/http/documents.controller.js';

/** Acceptance use case of the API, with the validation config shared with the worker. */
export function acceptInvoiceFor(db: Database) {
  return createAcceptInvoice({
    unitOfWork: createDrizzleAcceptanceUnitOfWork(db),
    validation: emissionValidationConfig(),
  });
}

/**
 * `POST /v1/documents` (HU-E5-01) and `GET /v1/documents` (HU-E5-07) and `GET /v1/documents/{id}/kude` (HU-E10-01). Without a `DATABASE` the app still boots and
 * `ApiKeyGuard` fails every request closed with 503 before the controller runs.
 */
@Module({
  controllers: [DocumentsController, DocumentQueryController],
  providers: [
    {
      provide: GET_DOCUMENT,
      useFactory: (db: Database | null) =>
        db
          ? createGetDocument({ reader: createDrizzleDocumentReader(db) })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    {
      provide: GET_KUDE,
      useFactory: (db: Database | null) =>
        db
          ? createGetKude({
              reader: createDrizzleDocumentReader(db),
              renderer: new PdfkitKudeRenderer(),
            })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    {
      provide: ACCEPT_CREDIT_NOTE,
      useFactory: (db: Database | null) =>
        db
          ? createAcceptCreditNote({
              unitOfWork: createDrizzleAcceptanceUnitOfWork(db),
              validation: emissionValidationConfig(),
            })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    // Slice E turns this on, together with the worker signing an NCE (HU-E7-01).
    { provide: CREDIT_NOTES_ENABLED, useValue: false },
    {
      provide: ACCEPT_INVOICE,
      useFactory: (db: Database | null) =>
        db ? acceptInvoiceFor(db) : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
  ],
})
export class EmissionModule {}
