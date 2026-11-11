import {
  createSoapSifenGateway,
  SifenClientCertificateError,
  SifenTenantUnavailableError,
  type SifenGateway,
  type SifenOperation,
} from '@sifen/sifen-gateway';
import { pkcs12ToMtlsCredential } from '../../certificates/infrastructure/pkcs12-mtls-credential.js';

type Environment = 'test' | 'production';

export interface TenantSoapGatewayDeps {
  /** The SIFEN environment the tenant works in right now (read on every call). */
  readonly environments: { environmentOf(tenantId: string): Promise<Environment> };
  /** The tenant's active certificate, decrypted in memory (cache and audit live behind this port). */
  readonly certificates: {
    open(tenantId: string, environment: Environment): Promise<{ p12: Buffer; password: string }>;
  };
  /** Production stays off until an operator opts in (`SIFEN_SOAP_ALLOW_PRODUCTION`). */
  readonly allowProduction: boolean;
  /** How long a call that could not start is deferred (`SifenTenantUnavailableError.retryAt`). */
  readonly retryAfterMs: number;
  readonly timeoutMs?: number;
  readonly maxTlsVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** Trust anchors for the SIFEN server (DNIT CA bundle); replaces the default roots when set. */
  readonly trustedRoots?: string;
  readonly logger?: { warn(message: string): void };
  readonly now?: () => Date;
  /** Tests only: endpoint overrides on a non-official host. Never derived from configuration. */
  readonly endpointOverrides?: Partial<Record<SifenOperation, string>>;
  readonly allowCustomHost?: boolean;
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
 * Builds a `SifenGateway` per tenant over the real SOAP adapter (ADR-0010: every tenant is its own
 * issuer, so mTLS uses its own certificate). Each call re-reads the tenant's environment, opens its
 * certificate through the audited, short-TTL cache, converts it to PEM in memory and hands it to the
 * transport, which opens one fresh connection (no agent, no reuse across tenants). Nothing is kept
 * or logged. A call that cannot start (no certificate, production not enabled) sends nothing, so it
 * fails as `SifenTenantUnavailableError` (also when SIFEN rejects the certificate at the handshake): callers
 * leave the work queued instead of treating it as unknown, and the shared circuit breaker ignores it.
 */
export class TenantSoapGatewayFactory {
  constructor(private readonly deps: TenantSoapGatewayDeps) {}

  forTenant(tenantId: string): SifenGateway {
    const gateway = {} as Record<SifenOperation, (request: never) => Promise<unknown>>;
    for (const operation of OPERATIONS) {
      gateway[operation] = (request) =>
        this.call(tenantId, operation, (inner) =>
          (inner[operation] as (r: never) => Promise<unknown>)(request),
        );
    }
    return gateway as unknown as SifenGateway;
  }

  private async call<T>(
    tenantId: string,
    operation: SifenOperation,
    run: (inner: SifenGateway) => Promise<T>,
  ): Promise<T> {
    const { deps } = this;
    let inner: SifenGateway;
    try {
      const environment = await deps.environments.environmentOf(tenantId);
      if (environment === 'production' && !deps.allowProduction) {
        throw new Error('SIFEN_SOAP_ALLOW_PRODUCTION is not enabled');
      }
      const opened = await deps.certificates.open(tenantId, environment);
      let credential;
      try {
        credential = pkcs12ToMtlsCredential(opened.p12, opened.password);
      } finally {
        opened.p12.fill(0);
      }
      inner = createSoapSifenGateway({
        ambiente: environment === 'production' ? 'prod' : 'test',
        allowProduction: deps.allowProduction,
        credentials: {
          load: () =>
            Promise.resolve({
              ...credential,
              ...(deps.trustedRoots === undefined ? {} : { ca: deps.trustedRoots }),
            }),
        },
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(deps.maxTlsVersion === undefined ? {} : { maxTlsVersion: deps.maxTlsVersion }),
        ...(deps.endpointOverrides === undefined ? {} : { endpoints: deps.endpointOverrides }),
        ...(deps.allowCustomHost === undefined ? {} : { allowCustomHost: deps.allowCustomHost }),
      });
    } catch (error) {
      // Ids and error names only: the message of a certificate error may describe the secret.
      deps.logger?.warn(
        `tenant ${tenantId}: SIFEN ${operation} not sent (${error instanceof Error ? error.name : 'unknown error'})`,
      );
      throw this.unavailable(operation, error);
    }
    try {
      return await run(inner);
    } catch (error) {
      if (error instanceof SifenClientCertificateError) {
        deps.logger?.warn(`tenant ${tenantId}: SIFEN ${operation} rejected the client certificate`);
        throw this.unavailable(operation, error);
      }
      throw error;
    }
  }

  private unavailable(operation: SifenOperation, cause: unknown): SifenTenantUnavailableError {
    const now = (this.deps.now ?? (() => new Date()))();
    return new SifenTenantUnavailableError(
      operation,
      new Date(now.getTime() + this.deps.retryAfterMs),
      { cause },
    );
  }
}
