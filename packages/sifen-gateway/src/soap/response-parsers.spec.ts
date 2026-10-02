import { describe, expect, it } from 'vitest';
import { SifenFaultError, SifenProtocolError } from '../errors.ts';
import {
  CDC_A,
  DE_XML,
  consDEEncontradoXml,
  consDEInexistenteXml,
  consRUCEncontradoXml,
  consRUCInexistenteXml,
  deAutorizadoXml,
  deRechazadoXml,
  eventosXml,
  CDC_B,
  fault11Xml,
  fault12Xml,
  loteConcluidoXml,
  loteEnProcesamientoXml,
  loteNoEncoladoXml,
  loteRecibidoXml,
} from '../../test/fixtures/soap/responses.ts';
import {
  parseConsultaDE,
  parseConsultaRUC,
  parseEventos,
  parseLoteReceipt,
  parseLoteResult,
  parseProtocoloDE,
  parseSoapBody,
} from './response-parsers.ts';

describe('parseSoapBody', () => {
  it('fails closed on a SOAP 1.2 Fault with its code and reason', () => {
    const error = catchError(() => parseSoapBody(fault12Xml, 'enviarLote'));
    expect(error).toBeInstanceOf(SifenFaultError);
    expect(error).toMatchObject({
      operation: 'enviarLote',
      code: 'env:Receiver',
      reason: 'Internal error',
    });
  });

  it('fails closed on a SOAP 1.1 style Fault', () => {
    expect(catchError(() => parseSoapBody(fault11Xml, 'consultarLote'))).toMatchObject({
      code: 's:Client',
      reason: 'Bad request',
    });
  });

  it.each([
    ['not xml', 'hello'],
    ['not an Envelope', '<html><body/></html>'],
    ['an Envelope without Body', '<e:Envelope xmlns:e="x"><e:Header/></e:Envelope>'],
    ['an empty Body', '<e:Envelope xmlns:e="x"><e:Body/></e:Envelope>'],
  ])('throws SifenProtocolError for %s', (_l, xml) => {
    expect(catchError(() => parseSoapBody(xml, 'enviarLote'))).toBeInstanceOf(SifenProtocolError);
  });

  it('rejects a response above the size cap before parsing it', () => {
    const big = `<e:Envelope xmlns:e="x"><e:Body><r>${'a'.repeat(2048)}</r></e:Body></e:Envelope>`;
    expect(catchError(() => parseSoapBody(big, 'enviarLote', { maxBytes: 1024 }))).toBeInstanceOf(
      SifenProtocolError,
    );
  });
});

describe('parseLoteReceipt', () => {
  it('reads a received lote whatever the namespace prefix', () => {
    expect(parseLoteReceipt(loteRecibidoXml)).toEqual({
      dCodRes: '0300',
      dMsgRes: 'Lote recibido con éxito',
      dProtConsLote: '47353',
    });
  });

  it('reads a not-queued lote with a default namespace and decoded entities, without protocol', () => {
    expect(parseLoteReceipt(loteNoEncoladoXml)).toEqual({
      dCodRes: '0301',
      dMsgRes: 'Lote no encolado & rechazado',
      dProtConsLote: null,
    });
  });

  it('rejects a body that is not rResEnviLoteDe or lacks dCodRes', () => {
    const wrong = loteRecibidoXml.replaceAll('rResEnviLoteDe', 'other');
    expect(catchError(() => parseLoteReceipt(wrong))).toBeInstanceOf(SifenProtocolError);
    const noCode = loteRecibidoXml.replace(/<ns2:dCodRes>.*?<\/ns2:dCodRes>/, '');
    expect(catchError(() => parseLoteReceipt(noCode))).toBeInstanceOf(SifenProtocolError);
  });
});

describe('parseLoteResult', () => {
  it('maps the lote code and the per-DE results with their messages', () => {
    expect(parseLoteResult(loteConcluidoXml)).toEqual({
      dCodRes: '0362',
      dMsgRes: 'Procesamiento de lote concluido',
      resultados: [
        {
          cdc: CDC_A,
          dEstRes: 'Aprobado',
          mensajes: [{ dCodRes: '0260', dMsgRes: 'Autorización del DE satisfactoria' }],
        },
        {
          cdc: CDC_B,
          dEstRes: 'Rechazado',
          mensajes: [
            { dCodRes: '1000', dMsgRes: 'CDC no corresponde con las informaciones del XML' },
          ],
        },
      ],
    });
  });

  it('returns no results while the lote is still processing', () => {
    expect(parseLoteResult(loteEnProcesamientoXml)).toEqual({
      dCodRes: '0361',
      dMsgRes: 'Lote en procesamiento',
      resultados: [],
    });
  });

  it('rejects a per-DE result whose id is not a 44-digit CDC', () => {
    const bad = loteConcluidoXml.replace(CDC_A, '123');
    expect(catchError(() => parseLoteResult(bad))).toBeInstanceOf(SifenProtocolError);
  });

  it('propagates SOAP Faults', () => {
    expect(catchError(() => parseLoteResult(fault12Xml))).toBeInstanceOf(SifenFaultError);
  });
});

describe('parseProtocoloDE', () => {
  it('reads the authorization from gResProc, whatever the namespace prefix', () => {
    expect(parseProtocoloDE(deAutorizadoXml)).toEqual({
      dCodRes: '0260',
      dMsgRes: 'Autorización del DE satisfactoria',
      dEstRes: 'Aprobado',
      dProtAut: '1234567890',
    });
  });

  it('reads a rejection without a transaction number', () => {
    expect(parseProtocoloDE(deRechazadoXml)).toEqual({
      dCodRes: '0160',
      dMsgRes: 'XML malformado',
      dEstRes: 'Rechazado',
      dProtAut: null,
    });
  });
});

describe('parseConsultaDE', () => {
  it('returns the stored DE as its exact source when found', () => {
    expect(parseConsultaDE(consDEEncontradoXml)).toEqual({
      dCodRes: '0422',
      dMsgRes: 'CDC encontrado',
      xmlDE: DE_XML,
    });
  });

  it('returns no DE when the CDC does not exist', () => {
    expect(parseConsultaDE(consDEInexistenteXml)).toEqual({
      dCodRes: '0420',
      dMsgRes: 'CDC inexistente',
      xmlDE: null,
    });
  });
});

describe('parseConsultaRUC', () => {
  it('maps the RUC container', () => {
    expect(parseConsultaRUC(consRUCEncontradoXml)).toEqual({
      dCodRes: '0502',
      dMsgRes: 'RUC encontrado',
      contribuyente: {
        ruc: '80069563',
        razonSocial: 'Empresa SA',
        estado: 'ACT',
        facturadorElectronico: true,
      },
    });
  });

  it('returns no taxpayer when the RUC does not exist', () => {
    expect(parseConsultaRUC(consRUCInexistenteXml)).toEqual({
      dCodRes: '0500',
      dMsgRes: 'RUC inexistente',
      contribuyente: null,
    });
  });
});

describe('parseEventos', () => {
  it('maps each event result; the headline is the first message of the first event', () => {
    expect(parseEventos(eventosXml)).toEqual({
      dCodRes: '0600',
      dMsgRes: 'Evento registrado correctamente',
      resultados: [
        {
          id: '77',
          dEstRes: 'Aprobado',
          mensajes: [{ dCodRes: '0600', dMsgRes: 'Evento registrado correctamente' }],
        },
        {
          id: '78',
          dEstRes: 'Rechazado',
          mensajes: [{ dCodRes: '4003', dMsgRes: 'El DE ya fue cancelado' }],
        },
      ],
    });
  });

  it('rejects a response with no event results and no code', () => {
    const empty = eventosXml.replace(/<ns2:gResProcEVe>.*<\/ns2:gResProcEVe>/, '');
    expect(catchError(() => parseEventos(empty))).toBeInstanceOf(SifenProtocolError);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}
