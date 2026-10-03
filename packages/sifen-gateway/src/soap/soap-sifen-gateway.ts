import { SifenFaultError, SifenTransportError } from '../errors.ts';
import type { SifenGateway, SifenOperation } from '../port.ts';
import type { SifenEndpoints } from './endpoints.ts';
import { buildLoteMessage } from './lote-message.ts';
import { buildConsultaLoteMessage } from './requests.ts';
import { parseLoteReceipt, parseLoteResult } from './response-parsers.ts';
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
export class SoapSifenGateway implements Pick<SifenGateway, 'enviarLote' | 'consultarLote'> {
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
    const ok = status >= 200 && status < 300;
    try {
      const parsed = parse(xml);
      if (ok) return parsed;
    } catch (error) {
      // A Fault is a real answer even on HTTP 500; any other failure on a non-2xx is a transport failure.
      if (ok || error instanceof SifenFaultError) throw error;
    }
    throw new SifenTransportError(operation, { cause: new Error(`HTTP ${String(status)}`) });
  }
}
