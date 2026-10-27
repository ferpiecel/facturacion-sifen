import { CircuitBreakerGateway, FakeSifenGateway, type SifenGateway } from '@sifen/sifen-gateway';
import { loadSoapGatewayConfig, SoapGatewayConfigError } from '../bootstrap/soap-gateway-config.js';
import {
  TenantSoapGatewayFactory,
  type TenantSoapGatewayDeps,
} from '../modules/transmission/infrastructure/tenant-soap-gateway.js';
import { WorkerConfigError } from './worker-config.js';

export interface WorkerSifenDeps {
  readonly logger: { warn(message: string): void };
  readonly readFile: (path: string) => string;
  readonly environments: TenantSoapGatewayDeps['environments'];
  readonly certificates: TenantSoapGatewayDeps['certificates'];
}

export interface WorkerSifen {
  /** The tenant's gateway; its circuits are shared by every tenant (HU-E6-08). */
  gatewayFor(tenantId: string): SifenGateway;
  /** When the send endpoint's circuit is open, the instant it may be tried again. */
  sendPausedUntil(): Date | null;
  /** True when the gateway is the in-process simulator, not SIFEN. */
  readonly simulator: boolean;
}

/** After a call that could not start (no certificate, production off) the work waits this long. */
const RETRY_AFTER_MS = 60_000;

/**
 * Picks the SIFEN gateway for the worker, failing closed at startup. `SIFEN_GATEWAY=simulator`
 * needs `NODE_ENV` of `development` or `test`; `SIFEN_GATEWAY=soap` talks to SIFEN with each
 * tenant's own certificate (ADR-0022). Both sit behind one circuit breaker per SIFEN endpoint,
 * shared by every tenant, since an outage belongs to the endpoint (ADR-0008).
 * @throws WorkerConfigError
 */
export function createWorkerSifen(env: NodeJS.ProcessEnv, deps: WorkerSifenDeps): WorkerSifen {
  const onStateChange = (operation: string, from: string, to: string): void => {
    deps.logger.warn(`SIFEN circuit ${operation}: ${from} -> ${to}`);
  };
  if (env.SIFEN_GATEWAY === 'simulator') {
    if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
      throw new WorkerConfigError('the simulator gateway is not allowed in production');
    }
    const breaker = new CircuitBreakerGateway(new FakeSifenGateway(), { onStateChange });
    return {
      gatewayFor: () => breaker,
      sendPausedUntil: () => breaker.pausedUntil('enviarLote'),
      simulator: true,
    };
  }
  if (env.SIFEN_GATEWAY !== 'soap') {
    throw new WorkerConfigError('no SIFEN gateway adapter is available for SIFEN_GATEWAY');
  }
  let config;
  try {
    config = loadSoapGatewayConfig(env, deps.readFile);
  } catch (error) {
    if (error instanceof SoapGatewayConfigError) throw new WorkerConfigError(error.message);
    throw error;
  }
  const factory = new TenantSoapGatewayFactory({
    environments: deps.environments,
    certificates: deps.certificates,
    allowProduction: config.allowProduction,
    retryAfterMs: RETRY_AFTER_MS,
    logger: deps.logger,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.trustedRoots === undefined ? {} : { trustedRoots: config.trustedRoots }),
  });
  // The breaker only needs an inner gateway to exist: every call goes through `around`.
  const breaker = new CircuitBreakerGateway(factory.forTenant(''), { onStateChange });
  return {
    gatewayFor: (tenantId) => breaker.around(factory.forTenant(tenantId)),
    sendPausedUntil: () => breaker.pausedUntil('enviarLote'),
    simulator: false,
  };
}
