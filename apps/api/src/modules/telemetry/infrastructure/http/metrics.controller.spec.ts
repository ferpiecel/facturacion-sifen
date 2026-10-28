import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetryRuntime } from '../telemetry-runtime.js';
import { MetricsController } from './metrics.controller.js';

function controller(metricsOpen: boolean, metricsToken?: string) {
  const metricsHandler = vi.fn();
  const runtime = {
    config: { metricsToken },
    metricsOpen,
    metricsHandler,
  } as unknown as TelemetryRuntime;
  return { controller: new MetricsController(runtime), metricsHandler };
}

const reply = { hijack: vi.fn(), raw: {} };
const request = (authorization?: string) => ({ headers: { authorization }, raw: {} });

describe('MetricsController', () => {
  it('answers 404 without a token outside development and test', () => {
    const { controller: c, metricsHandler } = controller(false);
    expect(() => {
      c.scrape(request() as never, reply as never);
    }).toThrow(NotFoundException);
    expect(metricsHandler).not.toHaveBeenCalled();
  });

  it('serves without a token in development and test', () => {
    const { controller: c, metricsHandler } = controller(true);
    c.scrape(request() as never, reply as never);
    expect(metricsHandler).toHaveBeenCalledOnce();
  });

  it('serves with a matching bearer token anywhere', () => {
    const { controller: c, metricsHandler } = controller(false, 'a'.repeat(16));
    c.scrape(request(`Bearer ${'a'.repeat(16)}`) as never, reply as never);
    expect(metricsHandler).toHaveBeenCalledOnce();
  });
});
