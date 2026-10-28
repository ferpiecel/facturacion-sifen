import xmlgen from 'facturacionelectronicapy-xmlgen';
import type {
  EventXmlBuilder,
  IssuerEvent,
  IssuerEventBuildInput,
  ReceiverEvent,
  ReceiptNoticeEvent,
  UnawarenessEvent,
} from '@sifen/sifen-gateway';
import { resolveCjsDefault } from './cjs-interop.ts';

type EventData = Record<string, unknown>;

interface XmlgenEventApi {
  generateXMLEventoCancelacion(id: number, params: EventData, data: EventData): Promise<string>;
  generateXMLEventoInutilizacion(id: number, params: EventData, data: EventData): Promise<string>;
  generateXMLEventoConformidad(id: number, params: EventData, data: EventData): Promise<string>;
  generateXMLEventoDisconformidad(id: number, params: EventData, data: EventData): Promise<string>;
  generateXMLEventoDesconocimiento(id: number, params: EventData, data: EventData): Promise<string>;
  generateXMLEventoNotificacion(id: number, params: EventData, data: EventData): Promise<string>;
}

const xmlgenApi = resolveCjsDefault(xmlgen) as XmlgenEventApi;

/** MT 11.5 GDE003: the event identifier is numeric, 1 to 10 digits. */
const MAX_EVENT_ID = 9_999_999_999;
/** Format version of the event (`dVerFor`, GDE005): MT v150. */
const EVENT_FORMAT_VERSION = 150;
/** The library wraps the event in a SOAP envelope with a `dId` we do not use: our gateway builds the batch envelope. */
const ENVELOPE_DID = 1;
const EVENT_GROUP = /<gGroupGesEve[\s\S]*<\/gGroupGesEve>/;
/** The library hardcodes this identifier; it is replaced before signing. */
const LIBRARY_EVENT_ID = '<rEve Id="1">';

/** SIFEN reads dates as Paraguay time (UTC-3 all year since October 2024) and the format carries no zone. */
const ASUNCION = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Asuncion',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * `AAAA-MM-DDThh:mm:ss` of the instant in Asunción, whatever the zone of the process. xmlgen formats the date it
 * is given with the local getters of the process, so it receives a zone-less string that reads the same there.
 */
export function asuncionWallClock(instant: Date): string {
  const part = (type: string): string =>
    ASUNCION.formatToParts(instant).find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

/** MT 11.1.1: a voiding covers up to 1000 numbers (4067) and its end is after its start (4068). */
const MAX_VOIDED_NUMBERS = 1000;

function assertVoidingRange(event: Extract<IssuerEvent, { kind: 'voiding' }>): void {
  if (!(event.to > event.from)) {
    throw new RangeError('The end of a voiding range must be after its start (4068)');
  }
  if (event.to - event.from + 1 > MAX_VOIDED_NUMBERS) {
    throw new RangeError(`A voiding covers at most ${String(MAX_VOIDED_NUMBERS)} numbers (4067)`);
  }
}

function dataFor(event: IssuerEvent | ReceiverEvent, signedAt: Date): EventData {
  const common = { fechaFirmaDigital: asuncionWallClock(signedAt) };
  switch (event.kind) {
    case 'cancellation':
      return { ...common, cdc: event.cdc, motivo: event.reason };
    case 'voiding':
      assertVoidingRange(event);
      return {
        ...common,
        timbrado: event.timbrado,
        establecimiento: event.establishment,
        punto: event.expeditionPoint,
        desde: event.from,
        hasta: event.to,
        tipoDocumento: event.documentType,
        motivo: event.reason,
        ...(event.series === undefined ? {} : { serie: event.series }),
      };
    case 'conformity':
      return {
        ...common,
        cdc: event.cdc,
        tipoConformidad: event.conformityType === 'total' ? 1 : 2,
        ...(event.estimatedReceiptAt === undefined
          ? {}
          : { fechaRecepcion: event.estimatedReceiptAt }),
      };
    case 'disconformity':
      return { ...common, cdc: event.cdc, motivo: event.reason };
    case 'unawareness':
      return { ...common, ...receiverData(event), motivo: event.reason };
    case 'receipt_notice':
      return { ...common, ...receiverData(event), totalPYG: event.totalPyg };
  }
}

/** Receiver of the DE/DTE as a taxpayer, with the dates the manual asks for the 45-day count (NT 019 1.1-1.2). */
function receiverData(event: UnawarenessEvent | ReceiptNoticeEvent): EventData {
  return {
    cdc: event.cdc,
    fechaEmision: event.issuedAt,
    fechaRecepcion: event.receivedAt,
    tipoReceptor: 1,
    nombre: event.receiver.name,
    ruc: event.receiver.ruc,
  };
}

function generate(input: IssuerEventBuildInput, data: EventData): Promise<string> {
  const params = { version: EVENT_FORMAT_VERSION };
  switch (input.event.kind) {
    case 'cancellation':
      return xmlgenApi.generateXMLEventoCancelacion(ENVELOPE_DID, params, data);
    case 'voiding':
      return xmlgenApi.generateXMLEventoInutilizacion(ENVELOPE_DID, params, data);
    case 'conformity':
      return xmlgenApi.generateXMLEventoConformidad(ENVELOPE_DID, params, data);
    case 'disconformity':
      return xmlgenApi.generateXMLEventoDisconformidad(ENVELOPE_DID, params, data);
    case 'unawareness':
      return xmlgenApi.generateXMLEventoDesconocimiento(ENVELOPE_DID, params, data);
    case 'receipt_notice':
      return xmlgenApi.generateXMLEventoNotificacion(ENVELOPE_DID, params, data);
  }
}

/**
 * Thin adapter over the event generators of `facturacionelectronicapy-xmlgen` (ADR-0015). The library
 * returns a whole SOAP envelope with `rEve/@Id` fixed to 1; this returns only the event group and sets
 * our identifier, so that signing and batching stay ours. It never mutates its input (the library does).
 */
export class TipsEventXmlBuilder implements EventXmlBuilder {
  async build(input: IssuerEventBuildInput): Promise<string> {
    if (!Number.isInteger(input.eventId) || input.eventId < 1 || input.eventId > MAX_EVENT_ID) {
      throw new RangeError('The event id is a whole number of 1 to 10 digits');
    }
    const data = dataFor(input.event, input.signedAt ?? new Date());
    const envelope = await generate(input, data);
    const group = EVENT_GROUP.exec(envelope)?.[0];
    if (!group?.includes(LIBRARY_EVENT_ID)) {
      throw new Error('The event generator returned no event group');
    }
    return group.replace(LIBRARY_EVENT_ID, `<rEve Id="${String(input.eventId)}">`);
  }
}
