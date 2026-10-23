import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CancelReasonInvalidError,
  CancellationAlreadyRequestedError,
  CancellationRefusedError,
  DocumentNotFoundError,
  EventKeyReusedError,
} from '../../application/cancel-document.js';
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
  if (error instanceof EventKeyReusedError) {
    return problem(HttpStatus.CONFLICT, error.message);
  }
  if (error instanceof EventIdExhaustedError) {
    return problem(HttpStatus.SERVICE_UNAVAILABLE, error.message);
  }
  return null;
}
