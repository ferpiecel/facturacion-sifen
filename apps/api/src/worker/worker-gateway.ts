import { FakeSifenGateway, type SifenGateway } from '@sifen/sifen-gateway';
import { WorkerConfigError } from './worker-config.js';

/**
 * Picks the SIFEN gateway for the worker. Only the in-process simulator exists today (the SOAP
 * adapter is a separate story), so the worker fails closed instead of pretending to transmit: the
 * simulator needs `SIFEN_GATEWAY=simulator` and `NODE_ENV` of `development` or `test`.
 */
export function createWorkerGateway(env: NodeJS.ProcessEnv): SifenGateway {
  if (env.SIFEN_GATEWAY !== 'simulator') {
    throw new WorkerConfigError('no SIFEN gateway adapter is available for SIFEN_GATEWAY');
  }
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new WorkerConfigError('the simulator gateway is not allowed in production');
  }
  return new FakeSifenGateway();
}
