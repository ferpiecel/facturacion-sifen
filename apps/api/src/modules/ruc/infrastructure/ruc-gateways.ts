import { CircuitBreakerGateway, FakeSifenGateway, type SifenGateway } from '@sifen/sifen-gateway';
import { parseSifenEnvironment } from '../../../bootstrap/environment.js';
import { loadSoapGatewayConfig } from '../../../bootstrap/soap-gateway-config.js';
import {
  TenantSoapGatewayFactory,
  type TenantSoapGatewayDeps,
} from '../../transmission/infrastructure/tenant-soap-gateway.js';
import type { RucEnvironment } from '../application/ports/ruc-cache.port.js';

/** What the lookup needs per calling tenant: its SIFEN gateway and the environment it works in. */
export interface RucGateways {
  gatewayFor(tenantId: string): SifenGateway;
  environmentOf(tenantId: string): Promise<RucEnvironment>;
}

/** Collaborators of the SOAP path (database, certificate vault), built only when it is selected. */
export interface SoapRucDeps {
  readonly environments: TenantSoapGatewayDeps['environments'];
  readonly certificates: TenantSoapGatewayDeps['certificates'];
  readonly logger: { warn(message: string): void };
}

export interface RucGatewaysDeps {
  readonly readFile: (path: string) => string;
  /** `null` when the database is not available. */
  readonly soap: () => SoapRucDeps | null;
}

/** After a call that could not start (no certificate, production off) retry no sooner than this. */
const RETRY_AFTER_MS = 60_000;

/**
 * Picks how `GET /v1/ruc/:ruc` reaches SIFEN. `SIFEN_GATEWAY=simulator` needs `NODE_ENV` of
 * `development` or `test` (same rule as the worker); `SIFEN_GATEWAY=soap` calls SIFEN with the
 * calling tenant's certificate and environment (ADR-0010, ADR-0022). `null` means no adapter is
 * available and the endpoint answers 503.
 * @throws SoapGatewayConfigError when the SOAP settings are invalid (the API does not start)
 */
export function createRucGateways(
  env: NodeJS.ProcessEnv,
  deps: RucGatewaysDeps,
): RucGateways | null {
  if (env.SIFEN_GATEWAY === 'simulator') {
    if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') return null;
    const gateway = new FakeSifenGateway();
    const environment = parseSifenEnvironment(env.SIFEN_ENVIRONMENT);
    return { gatewayFor: () => gateway, environmentOf: () => Promise.resolve(environment) };
  }
  if (env.SIFEN_GATEWAY !== 'soap') return null;
  const config = loadSoapGatewayConfig(env, deps.readFile);
  const soap = deps.soap();
  if (!soap) return null;
  const factory = new TenantSoapGatewayFactory({
    environments: soap.environments,
    certificates: soap.certificates,
    allowProduction: config.allowProduction,
    retryAfterMs: RETRY_AFTER_MS,
    logger: soap.logger,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.trustedRoots === undefined ? {} : { trustedRoots: config.trustedRoots }),
    ...(config.maxTlsVersion === undefined ? {} : { maxTlsVersion: config.maxTlsVersion }),
  });
  // One circuit per endpoint for every tenant of this process, like the worker (ADR-0008).
  const breaker = CircuitBreakerGateway.shared();
  return {
    gatewayFor: (tenantId) => breaker.around(factory.forTenant(tenantId)),
    environmentOf: (tenantId) => soap.environments.environmentOf(tenantId),
  };
}
