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

  it('applies per-operation overrides and refuses non-https URLs', () => {
    expect(sifenEndpoints('test', { consultarRUC: 'https://127.0.0.1:9/x' }).consultarRUC).toBe(
      'https://127.0.0.1:9/x',
    );
    expect(() => sifenEndpoints('test', { enviarLote: 'http://insecure.example/x' })).toThrow(
      RangeError,
    );
  });
});
