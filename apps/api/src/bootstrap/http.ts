import { FastifyAdapter } from '@nestjs/platform-fastify';

/**
 * Request body cap: 999 items fit within 1 MiB only with short descriptions (up to 2000 characters
 * each); a larger body is answered with 413.
 */
export const HTTP_BODY_LIMIT_BYTES = 1_048_576;

export function createHttpAdapter(): FastifyAdapter {
  return new FastifyAdapter({ bodyLimit: HTTP_BODY_LIMIT_BYTES });
}
