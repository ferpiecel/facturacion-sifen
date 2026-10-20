import { SifenTimeoutError, SifenTransportError } from '../errors.ts';
import type { SifenGateway, SifenOperation } from '../port.ts';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from './circuit-breaker.ts';

/**
 * Thrown instead of calling SIFEN while the endpoint's circuit is open. Nothing was sent, so callers
 * may safely keep the work queued (unlike a timeout, whose outcome is unknown).
 */
export class SifenCircuitOpenError extends Error {
  readonly name = 'SifenCircuitOpenError';
  readonly operation: SifenOperation;
  readonly retryAt: Date;

  constructor(operation: SifenOperation, retryAt: Date) {
    super(`SIFEN operation "${operation}" is paused by its circuit breaker`);
    this.operation = operation;
    this.retryAt = retryAt;
  }
}

export interface CircuitBreakerGatewayOptions extends Omit<CircuitBreakerOptions, 'onStateChange'> {
  readonly onStateChange?: (
    operation: SifenOperation,
    from: CircuitState,
    to: CircuitState,
  ) => void;
}

const OPERATIONS: readonly SifenOperation[] = [
  'enviarLote',
  'consultarLote',
  'enviarDESincronico',
  'consultarDE',
  'enviarEventos',
  'consultarRUC',
];

/**
 * Decorates a `SifenGateway` with one circuit breaker per endpoint (ADR-0008, HU-E6-08). Only
 * transport failures and timeouts count: any answer, even a SOAP fault, proves the endpoint is up.
 */
export class CircuitBreakerGateway implements SifenGateway {
  private readonly breakers = new Map<SifenOperation, CircuitBreaker>();
  private readonly inner: SifenGateway;

  constructor(inner: SifenGateway, options: CircuitBreakerGatewayOptions = {}) {
    this.inner = inner;
    const { onStateChange, ...rest } = options;
    for (const operation of OPERATIONS) {
      this.breakers.set(
        operation,
        new CircuitBreaker({
          ...rest,
          onStateChange: (from, to) => onStateChange?.(operation, from, to),
        }),
      );
    }
  }

  /**
   * The instant a paused endpoint may be tried again, or null when a call would go through. Lets a
   * caller leave work queued before it claims it, instead of learning from a refusal.
   */
  pausedUntil(operation: SifenOperation): Date | null {
    return this.breaker(operation).peek();
  }

  enviarLote: SifenGateway['enviarLote'] = (request) =>
    this.guard('enviarLote', () => this.inner.enviarLote(request));
  consultarLote: SifenGateway['consultarLote'] = (request) =>
    this.guard('consultarLote', () => this.inner.consultarLote(request));
  enviarDESincronico: SifenGateway['enviarDESincronico'] = (request) =>
    this.guard('enviarDESincronico', () => this.inner.enviarDESincronico(request));
  consultarDE: SifenGateway['consultarDE'] = (request) =>
    this.guard('consultarDE', () => this.inner.consultarDE(request));
  enviarEventos: SifenGateway['enviarEventos'] = (request) =>
    this.guard('enviarEventos', () => this.inner.enviarEventos(request));
  consultarRUC: SifenGateway['consultarRUC'] = (request) =>
    this.guard('consultarRUC', () => this.inner.consultarRUC(request));

  private breaker(operation: SifenOperation): CircuitBreaker {
    const breaker = this.breakers.get(operation);
    if (!breaker) throw new RangeError(`Unknown SIFEN operation "${operation}"`);
    return breaker;
  }

  private async guard<T>(operation: SifenOperation, call: () => Promise<T>): Promise<T> {
    const breaker = this.breaker(operation);
    const acquired = breaker.acquire();
    if (!acquired.allowed) throw new SifenCircuitOpenError(operation, acquired.retryAt);
    try {
      const result = await call();
      breaker.success(acquired.token);
      return result;
    } catch (error) {
      if (error instanceof SifenTransportError || error instanceof SifenTimeoutError) {
        breaker.failure(acquired.token);
      } else {
        // The endpoint answered (a fault, an unusable body) or the caller's request was invalid.
        breaker.success(acquired.token);
      }
      throw error;
    }
  }
}
