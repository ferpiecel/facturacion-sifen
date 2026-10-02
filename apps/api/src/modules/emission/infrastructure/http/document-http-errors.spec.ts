import { HttpException } from '@nestjs/common';
import { DocumentNumberExhaustedError } from '@sifen/db';
import { describe, expect, it } from 'vitest';
import {
  IdempotencyKeyReusedError,
  InvoiceValidationError,
  IssuerNotConfiguredError,
} from '../../application/accept-invoice.js';
import { toHttpException } from './document-http-errors.js';

function statusOf(error: unknown): number | undefined {
  const mapped = toHttpException(error);
  return mapped instanceof HttpException ? mapped.getStatus() : undefined;
}

/** Spec: HU-E5-01 (S3). Domain and persistence failures never surface as a raw 500. */
describe('toHttpException', () => {
  it('maps validation errors to 422 with the rule list', () => {
    const errors = [{ field: 'items', rule: 'items-required', message: 'At least one item' }];

    const mapped = toHttpException(new InvoiceValidationError(errors));

    expect(mapped?.getStatus()).toBe(422);
    expect(mapped?.getResponse()).toMatchObject({ statusCode: 422, errors });
  });

  it('maps an unconfigured issuer to 422', () => {
    expect(statusOf(new IssuerNotConfiguredError())).toBe(422);
  });

  it('maps a reused idempotency key with another payload to 409', () => {
    expect(statusOf(new IdempotencyKeyReusedError())).toBe(409);
    expect(toHttpException(new IdempotencyKeyReusedError())?.getResponse()).toMatchObject({
      message: expect.stringContaining('Idempotency-Key') as string,
    });
  });

  it('maps an exhausted numbering sequence to 409', () => {
    expect(statusOf(new DocumentNumberExhaustedError())).toBe(409);
  });

  it('maps a unique violation (also when wrapped as a cause) to a retryable 503', () => {
    expect(statusOf(Object.assign(new Error('dup'), { code: '23505' }))).toBe(503);
    expect(statusOf(new Error('query failed', { cause: { code: '23505' } }))).toBe(503);
  });

  it('leaves unknown errors alone', () => {
    expect(toHttpException(new Error('boom'))).toBeNull();
    expect(toHttpException('nope')).toBeNull();
  });
});
