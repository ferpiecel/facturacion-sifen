import { SifenProtocolError, SifenTransportError } from '../errors.ts';
import type { SifenGateway, SifenOperation } from '../port.ts';
import type { SifenEndpoints } from './endpoints.ts';
import { buildLoteMessage } from './lote-message.ts';
import {
  buildConsultaDEMessage,
  buildConsultaLoteMessage,
  buildConsultaRUCMessage,
  buildEnvioDEMessage,
  buildEventosMessage,
} from './requests.ts';
import {
  parseConsultaDE,
  parseConsultaRUC,
  parseEventos,
  parseLoteReceipt,
  parseLoteResult,
  parseProtocoloDE,
} from './response-parsers.ts';
import type { SoapTransport } from './transport.ts';

/** MT v150 §12.3.2.1: siRecepLoteDE messages above 10 000 KB are rejected (0270). */
const MAX_LOTE_MESSAGE_BYTES = 10_000 * 1024;

export interface SoapSifenGatewayOptions {
  readonly transport: SoapTransport;
  readonly endpoints: SifenEndpoints;
}

/**
 * Real SIFEN SOAP adapter. It never retries or polls (ADR-0007): every call is one request, and
 * timeouts, transport failures, SOAP Faults and unusable responses surface as typed errors for the
 * caller to treat as "outcome unknown".
 */
export class SoapSifenGateway implements SifenGateway {
  private readonly options: SoapSifenGatewayOptions;

  constructor(options: SoapSifenGatewayOptions) {
    this.options = options;
  }

  async enviarLote(request: Parameters<SifenGateway['enviarLote']>[0]) {
    const message = buildLoteMessage(request.des, request.dId);
    if (Buffer.byteLength(message) > MAX_LOTE_MESSAGE_BYTES) {
      throw new RangeError('The lote message exceeds the 10 000 KB limit of siRecepLoteDE');
    }
    return await this.call('enviarLote', message, parseLoteReceipt);
  }

  async consultarLote(request: Parameters<SifenGateway['consultarLote']>[0]) {
    return await this.call(
      'consultarLote',
      buildConsultaLoteMessage(request.dId, request.dProtConsLote),
      parseLoteResult,
    );
  }

  async enviarDESincronico(request: Parameters<SifenGateway['enviarDESincronico']>[0]) {
    return await this.call(
      'enviarDESincronico',
      buildEnvioDEMessage(request.dId, request.de),
      parseProtocoloDE,
    );
  }

  async consultarDE(request: Parameters<SifenGateway['consultarDE']>[0]) {
    return await this.call(
      'consultarDE',
      buildConsultaDEMessage(request.dId, request.cdc),
      parseConsultaDE,
    );
  }

  async enviarEventos(request: Parameters<SifenGateway['enviarEventos']>[0]) {
    return await this.call(
      'enviarEventos',
      buildEventosMessage(request.dId, request.eventos),
      parseEventos,
    );
  }

  async consultarRUC(request: Parameters<SifenGateway['consultarRUC']>[0]) {
    return await this.call(
      'consultarRUC',
      buildConsultaRUCMessage(request.dId, request.ruc),
      parseConsultaRUC,
    );
  }

  private async call<T>(
    operation: SifenOperation,
    body: string,
    parse: (xml: string) => T,
  ): Promise<T> {
    const { status, body: xml } = await this.options.transport.post({
      operation,
      url: this.options.endpoints[operation],
      body,
    });
    try {
      return parse(xml);
    } catch (error) {
      // A Fault is a real answer even on HTTP 500; any other unusable body on a non-2xx is a transport failure.
      if (error instanceof SifenProtocolError && (status < 200 || status >= 300)) {
        throw new SifenTransportError(operation, {
          cause: new Error(`HTTP ${String(status)}`, { cause: error }),
        });
      }
      throw error;
    }
  }
}
