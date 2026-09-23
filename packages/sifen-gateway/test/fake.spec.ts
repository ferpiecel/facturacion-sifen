import { beforeEach, describe, expect, it } from 'vitest';
import { SIFEN_CODES } from '../src/codes.ts';
import { SifenTimeoutError, SifenTransportError } from '../src/errors.ts';
import { FakeSifenGateway } from '../src/fake/fake-sifen-gateway.ts';
import * as scenarios from '../src/fake/scenarios.ts';
import { toCdc } from '../src/types.ts';

const dId = 1n;
const cdc = toCdc('1'.repeat(44));

describe('FakeSifenGateway defaults', () => {
  let gateway: FakeSifenGateway;

  beforeEach(() => {
    gateway = new FakeSifenGateway();
  });

  it('enviarLote resolves 0300 with a lote number by default', async () => {
    const result = await gateway.enviarLote({ dId, des: ['<DE/>'] });

    expect(result.dCodRes).toBe(SIFEN_CODES.LOTE_RECIBIDO);
    expect(result.dProtConsLote).toBeTruthy();
  });

  it('consultarLote resolves 0360 for an unscripted lote number', async () => {
    const result = await gateway.consultarLote({ dId, dProtConsLote: '999' });

    expect(result.dCodRes).toBe(SIFEN_CODES.LOTE_INEXISTENTE);
  });

  it('enviarDESincronico resolves 0260 by default', async () => {
    const result = await gateway.enviarDESincronico({ dId, de: '<DE/>' });

    expect(result.dCodRes).toBe(SIFEN_CODES.DE_AUTORIZADO);
  });

  it('consultarDE resolves 0420 for an unscripted CDC', async () => {
    const result = await gateway.consultarDE({ dId, cdc });

    expect(result.dCodRes).toBe(SIFEN_CODES.CDC_INEXISTENTE);
  });

  it('enviarEventos rejects when unscripted (no verified default)', async () => {
    await expect(gateway.enviarEventos({ dId, eventos: ['<evento/>'] })).rejects.toThrow(
      /No response configured/,
    );
  });

  it('consultarRUC rejects when unscripted (no verified default)', async () => {
    await expect(gateway.consultarRUC({ dId, ruc: '80012345-6' })).rejects.toThrow(
      /No response configured/,
    );
  });
});

describe('FakeSifenGateway scenarios', () => {
  let gateway: FakeSifenGateway;

  beforeEach(() => {
    gateway = new FakeSifenGateway();
  });

  it('enviarLote resolves 0301 when configured not queued', async () => {
    gateway.enqueue('enviarLote', scenarios.loteNoEncolado('Lote rechazado'));

    const result = await gateway.enviarLote({ dId, des: ['<DE/>'] });

    expect(result.dCodRes).toBe(SIFEN_CODES.LOTE_NO_ENCOLADO);
  });

  it('consultarLote scripts a FIFO sequence: en procesamiento then concluido', async () => {
    gateway.enqueue('consultarLote', scenarios.loteEnProcesamiento(), scenarios.loteConcluido());

    const first = await gateway.consultarLote({ dId, dProtConsLote: '123' });
    const second = await gateway.consultarLote({ dId, dProtConsLote: '123' });

    expect(first.dCodRes).toBe(SIFEN_CODES.LOTE_EN_PROCESAMIENTO);
    expect(second.dCodRes).toBe(SIFEN_CODES.LOTE_CONCLUIDO);
  });

  it('consultarLote resolves 0364 when configured as extemporaneous', async () => {
    gateway.enqueue('consultarLote', scenarios.consultaExtemporanea());

    const result = await gateway.consultarLote({ dId, dProtConsLote: '123' });

    expect(result.dCodRes).toBe(SIFEN_CODES.CONSULTA_EXTEMPORANEA);
  });

  it('consultarDE resolves 0422 when configured as found', async () => {
    gateway.enqueue('consultarDE', scenarios.cdcEncontrado('<DE/>'));

    const result = await gateway.consultarDE({ dId, cdc });

    expect(result.dCodRes).toBe(SIFEN_CODES.CDC_ENCONTRADO);
  });

  it('consultarDE resolves 0421 when the RUC lacks permission to consult the DE', async () => {
    gateway.enqueue('consultarDE', scenarios.rucCertificadoSinPermiso());

    const result = await gateway.consultarDE({ dId, cdc });

    expect(result.dCodRes).toBe(SIFEN_CODES.RUC_CERTIFICADO_SIN_PERMISO);
  });
});

describe('FakeSifenGateway enviarEventos batch limit', () => {
  it('rejects a call with more than 15 events without consuming the scripted response', async () => {
    const gateway = new FakeSifenGateway();
    gateway.enqueue('enviarEventos', { dCodRes: '0000', dMsgRes: 'never used', resultados: [] });
    const eventos = Array.from({ length: 16 }, (_, index) => `<evento id="${String(index)}"/>`);

    await expect(gateway.enviarEventos({ dId, eventos })).rejects.toThrow(RangeError);
    expect(gateway.callsTo('enviarEventos')).toHaveLength(1);

    const result = await gateway.enviarEventos({ dId, eventos: ['<evento/>'] });
    expect(result.dCodRes).toBe('0000');
  });
});

describe('FakeSifenGateway timeout and transport errors', () => {
  it('rejects with SifenTimeoutError, same tick, with no timers', async () => {
    const gateway = new FakeSifenGateway();
    gateway.enqueue('consultarRUC', new SifenTimeoutError('consultarRUC'));

    await expect(gateway.consultarRUC({ dId, ruc: '80012345-6' })).rejects.toBeInstanceOf(
      SifenTimeoutError,
    );
  });

  it('rejects with SifenTransportError when configured', async () => {
    const gateway = new FakeSifenGateway();
    gateway.enqueue('enviarLote', new SifenTransportError('enviarLote'));

    await expect(gateway.enviarLote({ dId, des: [] })).rejects.toBeInstanceOf(SifenTransportError);
  });
});

describe('FakeSifenGateway call recording', () => {
  it('records the operation and a defensive copy of the arguments passed', async () => {
    const gateway = new FakeSifenGateway();
    const request = { dId, des: ['<DE/>'] };

    await gateway.enviarLote(request);

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toEqual({ operation: 'enviarLote', args: [request] });
    expect(gateway.calls[0]?.args[0]).not.toBe(request);
  });

  it('callsTo filters recorded calls by operation', async () => {
    const gateway = new FakeSifenGateway();
    await gateway.enviarLote({ dId, des: [] });
    await gateway.enviarDESincronico({ dId, de: '<DE/>' });

    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
    expect(gateway.callsTo('enviarDESincronico')).toHaveLength(1);
  });
});

describe('FakeSifenGateway reset', () => {
  it('clears recorded calls, queued scenarios, and custom defaults', async () => {
    const gateway = new FakeSifenGateway();
    gateway.enqueue('consultarDE', scenarios.cdcEncontrado('<DE/>'));
    gateway.setDefault('enviarLote', scenarios.loteNoEncolado('rechazado'));
    await gateway.enviarLote({ dId, des: [] });

    gateway.reset();

    expect(gateway.calls).toHaveLength(0);

    const lote = await gateway.enviarLote({ dId, des: [] });
    expect(lote.dCodRes).toBe(SIFEN_CODES.LOTE_RECIBIDO);

    const de = await gateway.consultarDE({ dId, cdc });
    expect(de.dCodRes).toBe(SIFEN_CODES.CDC_INEXISTENTE);
  });
});
