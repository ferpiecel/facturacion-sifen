import type { SifenOperation } from './port.ts';

/** Thrown when a SIFEN operation does not respond within its configured timeout. */
export class SifenTimeoutError extends Error {
  readonly name = 'SifenTimeoutError';
  readonly operation: SifenOperation;

  constructor(operation: SifenOperation, options?: ErrorOptions) {
    super(`SIFEN operation "${operation}" timed out`, options);
    this.operation = operation;
  }
}

/** Thrown when a SIFEN operation fails at the transport level (network, TLS, etc.). */
export class SifenTransportError extends Error {
  readonly name = 'SifenTransportError';
  readonly operation: SifenOperation;

  constructor(operation: SifenOperation, options?: ErrorOptions) {
    super(`SIFEN operation "${operation}" failed at the transport layer`, options);
    this.operation = operation;
  }
}
