import { HttpException, HttpStatus } from '@nestjs/common';

/** 1 to 255 printable ASCII characters, no spaces. */
const IDEMPOTENCY_KEY = /^[!-~]{1,255}$/;

/**
 * Validates the `Idempotency-Key` header, which `POST /v1/documents` requires (ADR-0011).
 *
 * @throws HttpException 400 when it is missing or malformed.
 */
export function parseIdempotencyKey(header: string | undefined): string {
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY.test(header)) {
    throw new HttpException(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Idempotency-Key header is required: 1 to 255 printable ASCII characters',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  return header;
}
