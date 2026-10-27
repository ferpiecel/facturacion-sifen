import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { ReplyShape, RequestShape } from './fastify-shapes.js';
import { Public } from '../../../identity/infrastructure/decorators/public.decorator.js';
import { TELEMETRY_RUNTIME } from '../../telemetry.tokens.js';
import type { TelemetryRuntime } from '../telemetry-runtime.js';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Prometheus scrape endpoint. Absent (404) unless `METRICS_ENABLED=true`; with `METRICS_TOKEN` set it
 * requires `Authorization: Bearer <token>`, compared in constant time. Not part of the OpenAPI spec.
 */
@Controller('metrics')
@Public()
export class MetricsController {
  constructor(@Inject(TELEMETRY_RUNTIME) private readonly runtime: TelemetryRuntime) {}

  @Get()
  scrape(@Req() request: RequestShape, @Res() reply: ReplyShape): void {
    const { metricsHandler } = this.runtime;
    if (!metricsHandler) throw new NotFoundException();
    const expected = this.runtime.config.metricsToken;
    if (expected) {
      const given = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''))?.[1] ?? '';
      if (!timingSafeEqual(digest(given), digest(expected))) throw new UnauthorizedException();
    }
    reply.hijack();
    metricsHandler(request.raw, reply.raw);
  }
}
