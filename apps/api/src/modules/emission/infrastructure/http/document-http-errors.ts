import { HttpException, HttpStatus } from '@nestjs/common';
import { DocumentNumberExhaustedError } from '@sifen/db';
import type { ValidationError } from '../../domain/invoice-draft.js';
import {
  InvoiceValidationError,
  IssuerNotConfiguredError,
} from '../../application/accept-invoice.js';

/** Postgres SQLSTATE unique_violation. */
const UNIQUE_VIOLATION = '23505';

function problem(status: HttpStatus, message: string, extra: object = {}): HttpException {
  return new HttpException({ statusCode: status, message, ...extra }, status);
}

/** 422 body shared by shape errors (Zod) and domain errors. */
export function validationProblem(errors: ValidationError[]): HttpException {
  return problem(HttpStatus.UNPROCESSABLE_ENTITY, 'Validation failed', { errors });
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  return code === UNIQUE_VIOLATION || (cause !== undefined && isUniqueViolation(cause));
}

/**
 * Maps the failures of accepting an invoice to HTTP errors, using the API's
 * `{ statusCode, message, errors? }` body. Returns `null` for anything
 * unexpected so it still surfaces as a 500 (and is logged) instead of being masked.
 *
 * - 422: the request cannot be processed as sent (shape, rules, unknown emission point).
 * - 409: the point's numbering is exhausted; the integrator must use another point.
 * - 503: a CDC/number unique violation is a transient collision; the retry gets new values.
 */
export function toHttpException(error: unknown): HttpException | null {
  if (error instanceof InvoiceValidationError) {
    return validationProblem(error.errors);
  }
  if (error instanceof IssuerNotConfiguredError) {
    return problem(HttpStatus.UNPROCESSABLE_ENTITY, error.message);
  }
  if (error instanceof DocumentNumberExhaustedError) {
    return problem(
      HttpStatus.CONFLICT,
      'Document numbering is exhausted for this expedition point; use another point',
    );
  }
  if (isUniqueViolation(error)) {
    return problem(
      HttpStatus.SERVICE_UNAVAILABLE,
      'Temporary numbering collision; retry the request',
    );
  }
  return null;
}
