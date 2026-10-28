import { CircuitBreakerGateway, FakeSifenGateway, type SifenGateway } from '@sifen/sifen-gateway';
import { loadSoapGatewayConfig, SoapGatewayConfigError } from '../bootstrap/soap-gateway-config.js';
import {
  TenantSoapGatewayFactory,
  type TenantSoapGatewayDeps,
} from '../modules/transmission/infrastructure/tenant-soap-gateway.js';
import type { Telemetry } from '../modules/telemetry/application/ports/telemetry.port.js';
import { WorkerConfigError } from './worker-config.js';

export interface WorkerSifenDeps {
  readonly logger: { warn(message: string): void };
  readonly readFile: (path: string) => string;
  readonly environments: TenantSoapGatewayDeps['environments'];
  readonly certificates: TenantSoapGatewayDeps['certificates'];
  /** Publishes `sifen_circuit_state{operation}` on every breaker transition (HU-E14-01). */
  readonly telemetry?: Telemetry;
  /**
   * Wraps the real gateway (the simulator, or each tenant's SOAP gateway) BENEATH the shared
   * breaker, so only calls that reach SIFEN are timed and counted (HU-E14-01).
   */
  readonly decorate?: (gateway: SifenGateway) => SifenGateway;
}

const CIRCUIT_STATE_VALUE = { closed: 0, 'half-open': 1, open: 2 } as const;

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
  const decorate = deps.decorate ?? ((gateway: SifenGateway) => gateway);
  const onStateChange = (operation: string, from: string, to: string): void => {
    deps.logger.warn(`SIFEN circuit ${operation}: ${from} -> ${to}`);
    const value = CIRCUIT_STATE_VALUE[to as keyof typeof CIRCUIT_STATE_VALUE] as number | undefined;
    if (value !== undefined) deps.telemetry?.setGauge('sifen_circuit_state', value, { operation });
  };
  if (env.SIFEN_GATEWAY === 'simulator') {
    if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
      throw new WorkerConfigError('the simulator gateway is not allowed in production');
    }
    const breaker = new CircuitBreakerGateway(decorate(new FakeSifenGateway()), { onStateChange });
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
    ...(config.maxTlsVersion === undefined ? {} : { maxTlsVersion: config.maxTlsVersion }),
  });
  const breaker = CircuitBreakerGateway.shared({ onStateChange });
  return {
    gatewayFor: (tenantId) => breaker.around(decorate(factory.forTenant(tenantId))),
    sendPausedUntil: () => breaker.pausedUntil('enviarLote'),
    simulator: false,
  };
}
