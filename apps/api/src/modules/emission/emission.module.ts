import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { createAcceptInvoice } from './application/accept-invoice.js';
import { ACCEPT_INVOICE } from './emission.tokens.js';
import { createDrizzleAcceptanceUnitOfWork } from './infrastructure/drizzle-acceptance-unit-of-work.js';
import { DocumentsController } from './infrastructure/http/documents.controller.js';

/**
 * `POST /v1/documents` (HU-E5-01). Without a `DATABASE` the app still boots and
 * `ApiKeyGuard` fails every request closed with 503 before the controller runs.
 */
@Module({
  controllers: [DocumentsController],
  providers: [
    {
      provide: ACCEPT_INVOICE,
      useFactory: (db: Database | null) =>
        db
          ? createAcceptInvoice({ unitOfWork: createDrizzleAcceptanceUnitOfWork(db) })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
  ],
})
export class EmissionModule {}
