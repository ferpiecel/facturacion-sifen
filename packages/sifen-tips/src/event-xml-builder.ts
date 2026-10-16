import xmlgen from 'facturacionelectronicapy-xmlgen';
import type { EventXmlBuilder, IssuerEvent, IssuerEventBuildInput } from '@sifen/sifen-gateway';
import { resolveCjsDefault } from './cjs-interop.ts';

type EventData = Record<string, unknown>;

interface XmlgenEventApi {
  generateXMLEventoCancelacion(id: number, params: EventData, data: EventData): Promise<string>;
  generateXMLEventoInutilizacion(id: number, params: EventData, data: EventData): Promise<string>;
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

function dataFor(event: IssuerEvent, signedAt: Date): EventData {
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
    const params = { version: EVENT_FORMAT_VERSION };
    const data = dataFor(input.event, input.signedAt ?? new Date());
    const envelope =
      input.event.kind === 'cancellation'
        ? await xmlgenApi.generateXMLEventoCancelacion(ENVELOPE_DID, params, data)
        : await xmlgenApi.generateXMLEventoInutilizacion(ENVELOPE_DID, params, data);
    const group = EVENT_GROUP.exec(envelope)?.[0];
    if (!group?.includes(LIBRARY_EVENT_ID)) {
      throw new Error('The event generator returned no event group');
    }
    return group.replace(LIBRARY_EVENT_ID, `<rEve Id="${String(input.eventId)}">`);
  }
}
