import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { createCancelDocument } from './application/cancel-document.js';
import { createDrizzleCancellationUnitOfWork } from './infrastructure/drizzle-cancellation-unit-of-work.js';
import { IssuerEventsController } from './infrastructure/http/issuer-events.controller.js';
import { CANCEL_DOCUMENT } from './issuer-events.tokens.js';

/**
 * `POST /v1/documents/{id}/cancel` (HU-E8-02). Without a `DATABASE` the app still boots and `ApiKeyGuard`
 * fails every request closed with 503 before the controller runs.
 */
@Module({
  controllers: [IssuerEventsController],
  providers: [
    {
      provide: CANCEL_DOCUMENT,
      useFactory: (db: Database | null) =>
        db
          ? createCancelDocument({ unitOfWork: createDrizzleCancellationUnitOfWork(db) })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
  ],
})
export class IssuerEventsModule {}
