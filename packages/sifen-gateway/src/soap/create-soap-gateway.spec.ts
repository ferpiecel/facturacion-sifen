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
});
