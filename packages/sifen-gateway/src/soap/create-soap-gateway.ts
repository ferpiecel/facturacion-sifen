import type { Ambiente } from '../emission-ports.ts';
import type { SifenGateway, SifenOperation } from '../port.ts';
import { sifenEndpoints } from './endpoints.ts';
import { SoapSifenGateway } from './soap-sifen-gateway.ts';
import { createHttpsSoapTransport, type MtlsCredentialSource } from './transport.ts';

export interface CreateSoapSifenGatewayOptions {
  readonly ambiente: Ambiente;
  readonly credentials: MtlsCredentialSource;
  readonly endpoints?: Partial<Record<SifenOperation, string>>;
  readonly timeoutMs?: number;
  readonly maxTlsVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** Tests only: lets `endpoints` point at a non-official host. Never derive it from configuration. */
  readonly allowCustomHost?: boolean;
  /**
   * Production stays refused until the PoC validates this adapter against sifen-test; the caller
   * must opt in explicitly, so a misconfigured environment cannot reach production by default.
   */
  readonly allowProduction?: boolean;
}

/** Wires the real SOAP adapter with the mTLS transport. @throws Error for `prod` without `allowProduction` */
export function createSoapSifenGateway(options: CreateSoapSifenGatewayOptions): SifenGateway {
  if (options.ambiente === 'prod' && options.allowProduction !== true) {
    throw new Error(
      'The SOAP SIFEN gateway is not enabled for production yet (pending PoC validation)',
    );
  }
  return new SoapSifenGateway({
    transport: createHttpsSoapTransport({
      credentials: options.credentials,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxTlsVersion === undefined ? {} : { maxTlsVersion: options.maxTlsVersion }),
    }),
    endpoints: sifenEndpoints(options.ambiente, options.endpoints, {
      ...(options.allowCustomHost === undefined
        ? {}
        : { allowCustomHost: options.allowCustomHost }),
    }),
  });
}
