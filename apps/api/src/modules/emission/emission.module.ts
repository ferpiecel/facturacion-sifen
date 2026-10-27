import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { parseBlockDays } from '../certificates/domain/certificate-expiry.js';
import { DATABASE } from '../database/database.module.js';
import { createAcceptCreditNote, createAcceptDebitNote } from './application/accept-credit-note.js';
import { createAcceptInvoice } from './application/accept-invoice.js';
import { createAcceptRemission, createAcceptSelfInvoice } from './application/accept-standalone.js';
import { createGetDocument } from './application/get-document.js';
import { createGetKude } from './application/get-kude.js';
import { emissionValidationConfig } from './emission-validation-config.js';
import {
  ACCEPT_CREDIT_NOTE,
  ACCEPT_DEBIT_NOTE,
  ACCEPT_INVOICE,
  ACCEPT_REMISSION,
  ACCEPT_SELF_INVOICE,
  GET_DOCUMENT,
  GET_KUDE,
} from './emission.tokens.js';
import { createDrizzleAcceptanceUnitOfWork } from './infrastructure/drizzle-acceptance-unit-of-work.js';
import { createDrizzleDocumentReader } from './infrastructure/drizzle-document-reader.js';
import { createKudeRenderer } from './infrastructure/kude/kude-renderer.js';
import { DocumentQueryController } from './infrastructure/http/document-query.controller.js';
import { DocumentsController } from './infrastructure/http/documents.controller.js';

/** `CERTIFICATE_EMISSION_BLOCK_DAYS` (HU-E3-03); an invalid value stops the API at startup. */
function certificateBlockDays(): number {
  return parseBlockDays(process.env.CERTIFICATE_EMISSION_BLOCK_DAYS);
}

/** Acceptance use case of the API, with the validation config shared with the worker. */
export function acceptInvoiceFor(db: Database) {
  return createAcceptInvoice({
    unitOfWork: createDrizzleAcceptanceUnitOfWork(db),
    validation: emissionValidationConfig(),
    certificateBlockDays: certificateBlockDays(),
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
              renderer: createKudeRenderer(),
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
              certificateBlockDays: certificateBlockDays(),
            })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    {
      provide: ACCEPT_DEBIT_NOTE,
      useFactory: (db: Database | null) =>
        db
          ? createAcceptDebitNote({
              unitOfWork: createDrizzleAcceptanceUnitOfWork(db),
              validation: emissionValidationConfig(),
              certificateBlockDays: certificateBlockDays(),
            })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    {
      provide: ACCEPT_SELF_INVOICE,
      useFactory: (db: Database | null) =>
        db
          ? createAcceptSelfInvoice({
              unitOfWork: createDrizzleAcceptanceUnitOfWork(db),
              validation: emissionValidationConfig(),
              certificateBlockDays: certificateBlockDays(),
            })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    {
      provide: ACCEPT_REMISSION,
      useFactory: (db: Database | null) =>
        db
          ? createAcceptRemission({
              unitOfWork: createDrizzleAcceptanceUnitOfWork(db),
              validation: emissionValidationConfig(),
            })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    {
      provide: ACCEPT_INVOICE,
      useFactory: (db: Database | null) =>
        db ? acceptInvoiceFor(db) : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
  ],
})
export class EmissionModule {}
