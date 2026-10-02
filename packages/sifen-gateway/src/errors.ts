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

/** Thrown when SIFEN answers with a SOAP Fault. The call reached the server: the outcome is not a transport failure. */
export class SifenFaultError extends Error {
  readonly name = 'SifenFaultError';
  readonly operation: SifenOperation;
  readonly code: string;
  readonly reason: string;

  constructor(operation: SifenOperation, fault: { code: string; reason: string }) {
    super(`SIFEN operation "${operation}" returned a SOAP Fault (${fault.code}): ${fault.reason}`);
    this.operation = operation;
    this.code = fault.code;
    this.reason = fault.reason;
  }
}

/** Thrown when a SIFEN response is oversized, malformed, or not shaped like the documented protocol. */
export class SifenProtocolError extends Error {
  readonly name = 'SifenProtocolError';
  readonly operation: SifenOperation;

  constructor(operation: SifenOperation, detail: string, options?: ErrorOptions) {
    super(`SIFEN operation "${operation}" returned an unusable response: ${detail}`, options);
    this.operation = operation;
  }
}
