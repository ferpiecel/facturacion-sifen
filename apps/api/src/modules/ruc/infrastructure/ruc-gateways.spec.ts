import { FakeSifenGateway, SifenTenantUnavailableError } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import { SoapGatewayConfigError } from '../../../bootstrap/soap-gateway-config.js';
import { createRucGateways, type SoapRucDeps } from './ruc-gateways.js';

const soap: SoapRucDeps = {
  environments: { environmentOf: () => Promise.resolve('production' as const) },
  certificates: { open: () => Promise.reject(new Error('no active certificate')) },
  logger: { warn: () => undefined },
};
const readFile = (): string => '';

describe('createRucGateways', () => {
  it('uses the simulator in development and test, with the deployment environment', async () => {
    const gateways = createRucGateways(
      { SIFEN_GATEWAY: 'simulator', NODE_ENV: 'test', SIFEN_ENVIRONMENT: 'production' },
      { readFile, soap: () => soap },
    );
    expect(gateways?.gatewayFor('t-1')).toBeInstanceOf(FakeSifenGateway);
    await expect(gateways?.environmentOf('t-1')).resolves.toBe('production');
  });

  it('is unavailable (503) for the simulator in production and without a gateway', () => {
    expect(
      createRucGateways(
        { SIFEN_GATEWAY: 'simulator', NODE_ENV: 'production' },
        { readFile, soap: () => soap },
      ),
    ).toBeNull();
    expect(createRucGateways({ NODE_ENV: 'test' }, { readFile, soap: () => soap })).toBeNull();
  });

  it('is unavailable for soap without a database', () => {
    expect(createRucGateways({ SIFEN_GATEWAY: 'soap' }, { readFile, soap: () => null })).toBeNull();
  });

  it('fails fast on an invalid soap setting', () => {
    expect(() =>
      createRucGateways(
        { SIFEN_GATEWAY: 'soap', SIFEN_SOAP_TIMEOUT_MS: 'x' },
        { readFile, soap: () => soap },
      ),
    ).toThrow(SoapGatewayConfigError);
  });

  it("builds each tenant's SOAP gateway and its environment from the tenant", async () => {
    const gateways = createRucGateways({ SIFEN_GATEWAY: 'soap' }, { readFile, soap: () => soap });
    await expect(gateways?.environmentOf('t-1')).resolves.toBe('production');
    // Production is not allowed here, so the call is refused for that tenant without reaching SIFEN.
    await expect(
      gateways?.gatewayFor('t-1').consultarRUC({ dId: 1n, ruc: '80012345' }),
    ).rejects.toBeInstanceOf(SifenTenantUnavailableError);
  });
});
