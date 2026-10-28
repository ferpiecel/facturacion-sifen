import { describe, expect, it } from 'vitest';
import { loadSoapGatewayConfig, SoapGatewayConfigError } from './soap-gateway-config.js';

const PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
const read = () => PEM;

describe('loadSoapGatewayConfig', () => {
  it('has safe defaults: default timeout, default roots, production off', () => {
    expect(loadSoapGatewayConfig({}, read)).toEqual({ allowProduction: false });
  });

  it('reads the timeout, the production opt-in and the CA bundle', () => {
    expect(
      loadSoapGatewayConfig(
        {
          SIFEN_SOAP_TIMEOUT_MS: '45000',
          SIFEN_SOAP_ALLOW_PRODUCTION: 'true',
          SIFEN_SOAP_CA_FILE: '/etc/dnit.pem',
        },
        read,
      ),
    ).toEqual({ timeoutMs: 45_000, allowProduction: true, trustedRoots: PEM });
  });

  it('reads the maximum TLS version', () => {
    expect(loadSoapGatewayConfig({ SIFEN_TLS_MAX_VERSION: 'TLSv1.3' }, read)).toEqual({
      allowProduction: false,
      maxTlsVersion: 'TLSv1.3',
    });
  });

  it.each([
    { SIFEN_SOAP_TIMEOUT_MS: 'abc' },
    { SIFEN_SOAP_TIMEOUT_MS: '0' },
    { SIFEN_SOAP_TIMEOUT_MS: '600000' },
    { SIFEN_SOAP_ALLOW_PRODUCTION: 'yes' },
    { SIFEN_TLS_MAX_VERSION: 'TLSv1.1' },
  ])('fails fast on %o', (env) => {
    expect(() => loadSoapGatewayConfig(env, read)).toThrow(SoapGatewayConfigError);
  });

  it('fails fast when the CA file is unreadable or holds no certificate', () => {
    const env = { SIFEN_SOAP_CA_FILE: '/missing.pem' };
    expect(() =>
      loadSoapGatewayConfig(env, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow('SIFEN_SOAP_CA_FILE');
    expect(() => loadSoapGatewayConfig(env, () => 'nothing')).toThrow('SIFEN_SOAP_CA_FILE');
  });
});
