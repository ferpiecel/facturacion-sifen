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

/**
 * Thrown by the transport when the server rejects the client certificate at the TLS handshake
 * (unknown CA, expired, revoked, required but unusable). The fault is the tenant's credential, not
 * the endpoint: no request was processed and it must not feed the endpoint's circuit breaker.
 */
export class SifenClientCertificateError extends Error {
  readonly name = 'SifenClientCertificateError';
  readonly operation: SifenOperation;

  constructor(operation: SifenOperation, options?: ErrorOptions) {
    super(`SIFEN operation "${operation}" was refused for the client certificate`, options);
    this.operation = operation;
  }
}

/**
 * Thrown when a call cannot be made on behalf of ONE tenant (no usable certificate, a certificate
 * SIFEN rejects, production not enabled). Nothing was processed by SIFEN, so work may stay queued
 * until `retryAt`. It says nothing about the endpoint: the shared circuit breaker neither counts
 * it as a failure nor as a success.
 */
export class SifenTenantUnavailableError extends Error {
  readonly name = 'SifenTenantUnavailableError';
  readonly operation: SifenOperation;
  readonly retryAt: Date;

  constructor(operation: SifenOperation, retryAt: Date, options?: ErrorOptions) {
    super(`SIFEN operation "${operation}" cannot be made for this tenant`, options);
    this.operation = operation;
    this.retryAt = retryAt;
  }
}
