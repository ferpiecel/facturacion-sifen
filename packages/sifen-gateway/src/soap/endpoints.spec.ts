import { describe, expect, it } from 'vitest';
import { sifenEndpoints } from './endpoints.ts';

describe('sifenEndpoints (MT v150 §7.10)', () => {
  it('maps every operation to the test host', () => {
    expect(sifenEndpoints('test')).toEqual({
      enviarLote: 'https://sifen-test.set.gov.py/de/ws/async/recibe-lote.wsdl',
      consultarLote: 'https://sifen-test.set.gov.py/de/ws/consultas/consulta-lote.wsdl',
      enviarDESincronico: 'https://sifen-test.set.gov.py/de/ws/sync/recibe.wsdl',
      consultarDE: 'https://sifen-test.set.gov.py/de/ws/consultas/consulta.wsdl',
      enviarEventos: 'https://sifen-test.set.gov.py/de/ws/eventos/evento.wsdl',
      consultarRUC: 'https://sifen-test.set.gov.py/de/ws/consultas/consulta-ruc.wsdl',
    });
  });

  it('maps production to the production host', () => {
    expect(sifenEndpoints('prod').enviarLote).toBe(
      'https://sifen.set.gov.py/de/ws/async/recibe-lote.wsdl',
    );
  });

  it('accepts overrides on the official host of the chosen environment', () => {
    const url = 'https://sifen-test.set.gov.py/de/ws/other';
    expect(sifenEndpoints('test', { consultarRUC: url }).consultarRUC).toBe(url);
  });

  it.each([
    ['http scheme', 'test', 'http://sifen-test.set.gov.py/x'],
    [
      'the production host under test',
      'test',
      'https://sifen.set.gov.py/de/ws/async/recibe-lote.wsdl',
    ],
    ['the test host under prod', 'prod', 'https://sifen-test.set.gov.py/x'],
    ['an unrelated host', 'test', 'https://127.0.0.1:9/x'],
    ['userinfo spoofing', 'test', 'https://sifen-test.set.gov.py@evil.example/x'],
    ['a look-alike suffix', 'test', 'https://sifen-test.set.gov.py.evil.example/x'],
    ['an unparseable URL', 'test', 'not a url'],
  ] as const)('refuses an override with %s', (_label, ambiente, url) => {
    expect(() => sifenEndpoints(ambiente, { enviarLote: url })).toThrow(RangeError);
  });

  it('allows a custom host only with the explicit allowCustomHost option, still over https', () => {
    const url = 'https://127.0.0.1:9/x';
    expect(
      sifenEndpoints('test', { consultarRUC: url }, { allowCustomHost: true }).consultarRUC,
    ).toBe(url);
    expect(() =>
      sifenEndpoints('test', { consultarRUC: 'http://127.0.0.1:9/x' }, { allowCustomHost: true }),
    ).toThrow(RangeError);
  });
});
