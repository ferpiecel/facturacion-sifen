import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CancelReasonInvalidError,
  CancellationAlreadyRequestedError,
  CancellationRefusedError,
  DocumentNotFoundError,
  EventKeyReusedError,
} from '../../application/cancel-document.js';
import {
  ReceiverEventInvalidError,
  ReceiverEventRefusedError,
  ReceiverProfileMissingError,
} from '../../application/register-receiver-event.js';
import {
  ReceiverCorrectionRefusedError,
  ReceiverEventNotFoundError,
} from '../../application/correct-receiver-event.js';
import { EventKeyCollisionError } from '../../application/ports/cancellation-unit-of-work.port.js';
import { VoidRefusedError } from '../../application/void-numbers.js';
import { EventIdExhaustedError } from '../drizzle-event-support.js';

function problem(status: HttpStatus, message: string, errors?: object[]): HttpException {
  return new HttpException({ statusCode: status, message, ...(errors ? { errors } : {}) }, status);
}

/**
 * Maps the failures of requesting an issuer event to HTTP errors, with the API's
 * `{ statusCode, message, errors? }` body. Anything unexpected returns `null` and surfaces as a 500.
 *
 * - 404: no such document for the tenant.
 * - 409: the key was used with another request, or the document already has the event.
 * - 422: a rule of the manual or the platform refuses it; `errors[0].rule` names it (and `sifenCode`).
 */
export function toIssuerEventHttpException(error: unknown): HttpException | null {
  if (error instanceof DocumentNotFoundError) {
    return problem(HttpStatus.NOT_FOUND, error.message);
  }
  if (error instanceof CancelReasonInvalidError) {
    return problem(HttpStatus.UNPROCESSABLE_ENTITY, 'Validation failed', [
      { field: 'reason', rule: 'reason-length', message: error.message },
    ]);
  }
  if (error instanceof CancellationRefusedError) {
    const { message, ...details } = error.refusal;
    return problem(HttpStatus.UNPROCESSABLE_ENTITY, 'The cancellation was refused', [
      {
        field: 'document',
        message,
        ...details,
        ...('deadline' in details ? { deadline: details.deadline.toISOString() } : {}),
      },
    ]);
  }
  if (error instanceof VoidRefusedError) {
    return problem(HttpStatus.UNPROCESSABLE_ENTITY, 'The voiding was refused', error.errors);
  }
  if (error instanceof CancellationAlreadyRequestedError) {
    return problem(HttpStatus.CONFLICT, error.message, [
      {
        field: 'document',
        rule: 'cancellation-already-requested',
        sifenCode: '4003',
        message: error.message,
      },
    ]);
  }
  if (error instanceof ReceiverEventInvalidError) {
    return problem(HttpStatus.UNPROCESSABLE_ENTITY, 'Validation failed', error.issues);
  }
  if (error instanceof ReceiverEventRefusedError) {
    const { message, ...details } = error.refusal;
    const status =
      details.rule === 'receiver-event-already-registered'
        ? HttpStatus.CONFLICT
        : HttpStatus.UNPROCESSABLE_ENTITY;
    return problem(status, 'The receiver event was refused', [
      {
        field: 'event',
        message,
        ...details,
        ...('deadline' in details ? { deadline: details.deadline.toISOString() } : {}),
      },
    ]);
  }
  if (error instanceof ReceiverProfileMissingError) {
    return problem(HttpStatus.UNPROCESSABLE_ENTITY, error.message, [
      { field: 'tenant', rule: 'receiver-profile-missing', message: error.message },
    ]);
  }
  if (error instanceof ReceiverEventNotFoundError) {
    return problem(HttpStatus.NOT_FOUND, error.message);
  }
  if (error instanceof ReceiverCorrectionRefusedError) {
    const { message, ...details } = error.refusal;
    const status =
      details.rule === 'correction-already-requested'
        ? HttpStatus.CONFLICT
        : HttpStatus.UNPROCESSABLE_ENTITY;
    return problem(status, 'The correction was refused', [
      {
        field: 'event',
        message,
        ...details,
        ...('deadline' in details ? { deadline: details.deadline.toISOString() } : {}),
      },
    ]);
  }
  if (error instanceof EventKeyReusedError || error instanceof EventKeyCollisionError) {
    return problem(HttpStatus.CONFLICT, 'The Idempotency-Key was already used by another event.');
  }
  if (error instanceof EventIdExhaustedError) {
    return problem(HttpStatus.SERVICE_UNAVAILABLE, error.message);
  }
  return null;
}
