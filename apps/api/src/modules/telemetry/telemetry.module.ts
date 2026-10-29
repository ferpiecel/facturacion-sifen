import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsController } from './infrastructure/http/metrics.controller.js';
import { TraceInterceptor } from './infrastructure/http/trace.interceptor.js';
import {
  createTelemetryRuntime,
  type TelemetryRuntime,
} from './infrastructure/telemetry-runtime.js';
import { TELEMETRY, TELEMETRY_RUNTIME } from './telemetry.tokens.js';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: TELEMETRY_RUNTIME, useFactory: () => createTelemetryRuntime(process.env) },
    {
      provide: TELEMETRY,
      useFactory: (runtime: TelemetryRuntime) => runtime.telemetry,
      inject: [TELEMETRY_RUNTIME],
    },
    { provide: APP_INTERCEPTOR, useClass: TraceInterceptor },
  ],
  exports: [TELEMETRY],
})
export class TelemetryModule implements OnApplicationShutdown {
  constructor(@Inject(TELEMETRY_RUNTIME) private readonly runtime: TelemetryRuntime) {}

  async onApplicationShutdown(): Promise<void> {
    await this.runtime.shutdown();
  }
}
