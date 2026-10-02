import { describe, expect, it } from 'vitest';
import { createSoapSifenGateway } from './create-soap-gateway.ts';
import { SoapSifenGateway } from './soap-sifen-gateway.ts';

const credentials = { load: () => Promise.resolve({ key: 'k', cert: 'c' }) };

describe('createSoapSifenGateway', () => {
  it('builds a gateway for the test environment', () => {
    expect(createSoapSifenGateway({ ambiente: 'test', credentials })).toBeInstanceOf(
      SoapSifenGateway,
    );
  });

  it('refuses production until it is explicitly enabled (pending PoC validation in sifen-test)', () => {
    expect(() => createSoapSifenGateway({ ambiente: 'prod', credentials })).toThrow(/production/i);
    expect(
      createSoapSifenGateway({ ambiente: 'prod', credentials, allowProduction: true }),
    ).toBeInstanceOf(SoapSifenGateway);
  });

  it('cannot reach production through an override while running as test', () => {
    const endpoints = { enviarLote: 'https://sifen.set.gov.py/de/ws/async/recibe-lote.wsdl' };
    expect(() => createSoapSifenGateway({ ambiente: 'test', credentials, endpoints })).toThrow(RangeError);
    expect(() =>
      createSoapSifenGateway({ ambiente: 'prod', credentials, endpoints: { enviarLote: 'https://127.0.0.1/x' } }),
    ).toThrow();
  });

  it('keeps the production gate even with an official production override', () => {
    const endpoints = { enviarLote: 'https://sifen.set.gov.py/de/ws/async/recibe-lote.wsdl' };
    expect(() => createSoapSifenGateway({ ambiente: 'prod', credentials, endpoints })).toThrow(/production/i);
  });
});
