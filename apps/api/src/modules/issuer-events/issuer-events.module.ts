import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { createCancelDocument } from './application/cancel-document.js';
import { createVoidNumbers } from './application/void-numbers.js';
import { createDrizzleCancellationUnitOfWork } from './infrastructure/drizzle-cancellation-unit-of-work.js';
import { createDrizzleVoidingUnitOfWork } from './infrastructure/drizzle-voiding-unit-of-work.js';
import { IssuerEventsController } from './infrastructure/http/issuer-events.controller.js';
import { NumberingEventsController } from './infrastructure/http/numbering-events.controller.js';
import { CANCEL_DOCUMENT, VOID_NUMBERS } from './issuer-events.tokens.js';

/**
 * `POST /v1/documents/{id}/cancel` (HU-E8-02) and `POST /v1/numbering/inutilize` (HU-E8-03).
 * Without a `DATABASE` the app still boots and `ApiKeyGuard` fails every request closed with 503
 * before the controller runs.
 */
@Module({
  controllers: [IssuerEventsController, NumberingEventsController],
  providers: [
    {
      provide: CANCEL_DOCUMENT,
      useFactory: (db: Database | null) =>
        db
          ? createCancelDocument({ unitOfWork: createDrizzleCancellationUnitOfWork(db) })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    {
      provide: VOID_NUMBERS,
      useFactory: (db: Database | null) =>
        db
          ? createVoidNumbers({ unitOfWork: createDrizzleVoidingUnitOfWork(db) })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
  ],
})
export class IssuerEventsModule {}
