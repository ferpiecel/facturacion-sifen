import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { createCancelDocument } from './application/cancel-document.js';
import { createCorrectReceiverEvent } from './application/correct-receiver-event.js';
import { createDrizzleCorrectionUnitOfWork } from './infrastructure/drizzle-correction-unit-of-work.js';
import { createRegisterReceiverEvent } from './application/register-receiver-event.js';
import { createVoidNumbers } from './application/void-numbers.js';
import { createDrizzleCancellationUnitOfWork } from './infrastructure/drizzle-cancellation-unit-of-work.js';
import { createDrizzleReceiverEventUnitOfWork } from './infrastructure/drizzle-receiver-event-unit-of-work.js';
import { createDrizzleVoidingUnitOfWork } from './infrastructure/drizzle-voiding-unit-of-work.js';
import { IssuerEventsController } from './infrastructure/http/issuer-events.controller.js';
import { NumberingEventsController } from './infrastructure/http/numbering-events.controller.js';
import { ReceiverEventsController } from './infrastructure/http/receiver-events.controller.js';
import { readReceiverEventConfig } from './infrastructure/receiver-event-config.js';
import {
  CANCEL_DOCUMENT,
  CORRECT_RECEIVER_EVENT,
  REGISTER_RECEIVER_EVENT,
  VOID_NUMBERS,
} from './issuer-events.tokens.js';

/**
 * `POST /v1/documents/{id}/cancel` (HU-E8-02), `POST /v1/numbering/inutilize` (HU-E8-03) and
 * `POST /v1/receiver-events` (HU-E9-01).
 * Without a `DATABASE` the app still boots and `ApiKeyGuard` fails every request closed with 503
 * before the controller runs.
 */
@Module({
  controllers: [IssuerEventsController, NumberingEventsController, ReceiverEventsController],
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
    {
      provide: CORRECT_RECEIVER_EVENT,
      useFactory: (db: Database | null) =>
        db
          ? createCorrectReceiverEvent({
              unitOfWork: createDrizzleCorrectionUnitOfWork(db),
              config: readReceiverEventConfig(),
            })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
    {
      provide: REGISTER_RECEIVER_EVENT,
      useFactory: (db: Database | null) =>
        db
          ? createRegisterReceiverEvent({
              unitOfWork: createDrizzleReceiverEventUnitOfWork(db),
              config: readReceiverEventConfig(),
            })
          : () => Promise.reject(new ServiceUnavailableException()),
      inject: [DATABASE],
    },
  ],
})
export class IssuerEventsModule {}
