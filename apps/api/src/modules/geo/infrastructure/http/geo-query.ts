import { HttpException, HttpStatus } from '@nestjs/common';

const CODE = /^[1-9]\d{0,4}$/;

/** @throws HttpException 400 when the query parameter is missing, repeated or not a code of up to 5 digits. */
export function parseCodeQuery(name: string, raw: unknown): number {
  if (typeof raw !== 'string' || !CODE.test(raw)) {
    throw new HttpException(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        message: `Query parameter ${name} is required: a code of 1 to 5 digits`,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  return Number(raw);
}
