import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { ReplyShape, RequestShape } from './fastify-shapes.js';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { Telemetry } from '../../application/ports/telemetry.port.js';
import { TELEMETRY } from '../../telemetry.tokens.js';

/**
 * One server span per request, named by method and route pattern (never the raw URL: it carries ids
 * and query strings), and the trace id echoed as `x-trace-id` so an integrator can quote it.
 */
@Injectable()
export class TraceInterceptor implements NestInterceptor {
  constructor(@Inject(TELEMETRY) private readonly telemetry: Telemetry) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestShape>();
    const reply = http.getResponse<ReplyShape>();
    const route = request.routeOptions.url ?? 'unknown';
    return from(
      this.telemetry.withSpan(
        `${request.method} ${route}`,
        { 'http.request.method': request.method, 'http.route': route },
        async (span) => {
          if (span.traceId) reply.header('x-trace-id', span.traceId);
          return lastValueFrom(next.handle() as Observable<unknown>, { defaultValue: undefined });
        },
      ),
    );
  }
}
