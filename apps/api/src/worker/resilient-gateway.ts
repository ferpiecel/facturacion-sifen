import { CircuitBreakerGateway, type SifenGateway } from '@sifen/sifen-gateway';

export interface ResilientGatewayOptions {
  readonly logger: { warn(message: string): void };
  readonly now?: () => Date;
}

/**
 * Wraps the worker's gateway with one circuit breaker per SIFEN endpoint (HU-E6-08, ADR-0008): while
 * SIFEN is down the worker stops calling it and signed documents stay queued, never lost. The
 * breakers are shared by every tenant, since an outage belongs to the endpoint. Defaults: open after
 * 5 consecutive transport failures, 30 s cool-down doubling up to 15 min.
 */
export function withCircuitBreaker(
  inner: SifenGateway,
  { logger, now }: ResilientGatewayOptions,
): { readonly gateway: CircuitBreakerGateway; readonly sendPausedUntil: () => Date | null } {
  const gateway = new CircuitBreakerGateway(inner, {
    now,
    onStateChange: (operation, from, to) => {
      logger.warn(`SIFEN circuit ${operation}: ${from} -> ${to}`);
    },
  });
  return { gateway, sendPausedUntil: () => gateway.pausedUntil('enviarLote') };
}
