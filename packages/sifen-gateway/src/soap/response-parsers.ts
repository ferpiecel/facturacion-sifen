import { SifenFaultError, SifenProtocolError } from '../errors.ts';
import type { SifenOperation } from '../port.ts';
import {
  toCdc,
  type SifenConsDE,
  type SifenConsRUC,
  type SifenEventosResult,
  type SifenLoteReceipt,
  type SifenLoteResult,
  type SifenProtocoloDE,
  type SifenResultadoDE,
} from '../types.ts';
import { XmlParseError, childText, children, firstChild, parseXml, type XmlNode } from './xml.ts';

/** Default response size cap. Requests are capped at 10 000 KB (MT §12.3.2.1) but responses stay far smaller. */
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface ParseOptions {
  readonly maxBytes?: number;
}

function protocolError(
  operation: SifenOperation,
  detail: string,
  cause?: unknown,
): SifenProtocolError {
  return new SifenProtocolError(operation, detail, cause === undefined ? undefined : { cause });
}

function faultOf(fault: XmlNode): { code: string; reason: string } {
  // SOAP 1.2: Code/Value + Reason/Text. SOAP 1.1: faultcode + faultstring.
  const code =
    childText(firstChild(fault, 'Code') ?? fault, 'Value') ?? childText(fault, 'faultcode');
  const reason =
    childText(firstChild(fault, 'Reason') ?? fault, 'Text') ?? childText(fault, 'faultstring');
  return { code: code ?? 'unknown', reason: reason ?? 'unknown' };
}

/**
 * Returns the first element inside `soap:Body`, failing closed on a SOAP Fault.
 * @throws SifenFaultError for a Fault; SifenProtocolError when oversized, malformed or not an Envelope
 */
export function parseSoapBody(
  xml: string,
  operation: SifenOperation,
  options: ParseOptions = {},
): XmlNode {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (Buffer.byteLength(xml) > maxBytes)
    throw protocolError(operation, `response exceeds ${String(maxBytes)} bytes`);

  let envelope: XmlNode;
  try {
    envelope = parseXml(xml);
  } catch (error) {
    if (error instanceof XmlParseError)
      throw protocolError(operation, 'response is not well-formed XML', error);
    throw error;
  }
  if (envelope.name !== 'Envelope')
    throw protocolError(operation, 'response is not a SOAP Envelope');
  const content = firstChild(envelope, 'Body')?.children[0];
  if (content === undefined) throw protocolError(operation, 'SOAP Body is missing or empty');
  if (content.name === 'Fault') throw new SifenFaultError(operation, faultOf(content));
  return content;
}

function requireText(node: XmlNode, name: string, operation: SifenOperation): string {
  const value = childText(node, name);
  if (value === undefined) throw protocolError(operation, `<${name}> is missing in <${node.name}>`);
  return value;
}

function bodyAs(
  xml: string,
  operation: SifenOperation,
  root: string,
  options?: ParseOptions,
): XmlNode {
  const body = parseSoapBody(xml, operation, options);
  if (body.name !== root)
    throw protocolError(operation, `expected <${root}>, received <${body.name}>`);
  return body;
}

/** siRecepLoteDE response (MT v150 §9.2.3, schema 6: rResEnviLoteDe). */
export function parseLoteReceipt(xml: string, options?: ParseOptions): SifenLoteReceipt {
  const body = bodyAs(xml, 'enviarLote', 'rResEnviLoteDe', options);
  return {
    dCodRes: requireText(body, 'dCodRes', 'enviarLote'),
    dMsgRes: requireText(body, 'dMsgRes', 'enviarLote'),
    dProtConsLote: childText(body, 'dProtConsLote') || null,
  };
}

function parseResultadoDE(node: XmlNode): SifenResultadoDE {
  const id = requireText(node, 'id', 'consultarLote');
  let cdc: SifenResultadoDE['cdc'];
  try {
    cdc = toCdc(id);
  } catch (error) {
    throw protocolError('consultarLote', `<id> "${id}" is not a CDC`, error);
  }
  return {
    cdc,
    dEstRes: requireText(node, 'dEstRes', 'consultarLote'),
    mensajes: children(node, 'gResProc').map((message) => ({
      dCodRes: requireText(message, 'dCodRes', 'consultarLote'),
      dMsgRes: requireText(message, 'dMsgRes', 'consultarLote'),
    })),
  };
}

/** siResultLoteDE response (MT v150 §9.3.3, schema 8: rResEnviConsLoteDe). */
export function parseLoteResult(xml: string, options?: ParseOptions): SifenLoteResult {
  const body = bodyAs(xml, 'consultarLote', 'rResEnviConsLoteDe', options);
  return {
    dCodRes: requireText(body, 'dCodResLot', 'consultarLote'),
    dMsgRes: requireText(body, 'dMsgResLot', 'consultarLote'),
    resultados: children(body, 'gResProcLote').map(parseResultadoDE),
  };
}

/**
 * siRecepDE response (MT v150 §9.1, schemas 3-4: rRetEnviDe/rProtDe). The MT table nests the result
 * fields under `gResProc` while its §7.4 example does too; they are also accepted directly under `rProtDe`.
 */
export function parseProtocoloDE(xml: string, options?: ParseOptions): SifenProtocoloDE {
  const body = bodyAs(xml, 'enviarDESincronico', 'rRetEnviDe', options);
  const protocolo = firstChild(body, 'rProtDe');
  if (protocolo === undefined) throw protocolError('enviarDESincronico', '<rProtDe> is missing');
  const result = firstChild(protocolo, 'gResProc') ?? protocolo;
  return {
    dCodRes: requireText(result, 'dCodRes', 'enviarDESincronico'),
    dMsgRes: requireText(result, 'dMsgRes', 'enviarDESincronico'),
    dEstRes: childText(result, 'dEstRes') ?? childText(protocolo, 'dEstRes') ?? null,
    dProtAut: (childText(result, 'dProtAut') ?? childText(protocolo, 'dProtAut')) || null,
  };
}

/**
 * siConsDE response (MT v150 §9.4.3, schemas 10-11). `xmlDE` is the stored `rDE` exactly as received;
 * when the response qualifies it with a prefix declared on an ancestor, that declaration is not part of it.
 */
export function parseConsultaDE(xml: string, options?: ParseOptions): SifenConsDE {
  const body = bodyAs(xml, 'consultarDE', 'rResEnviConsDe', options);
  const container = firstChild(body, 'xContenDE');
  const de =
    container === undefined
      ? undefined
      : firstChild(firstChild(container, 'rContDe') ?? container, 'rDE');
  return {
    dCodRes: requireText(body, 'dCodRes', 'consultarDE'),
    dMsgRes: requireText(body, 'dMsgRes', 'consultarDE'),
    xmlDE: de?.raw ?? null,
  };
}

/** `dRUCFactElec` is exactly S or N (MT v150 schema 17): anything else is not a usable answer. */
function parseSiNo(value: string): boolean {
  if (value !== 'S' && value !== 'N') {
    throw protocolError('consultarRUC', `<dRUCFactElec> must be S or N, received "${value}"`);
  }
  return value === 'S';
}

/** siConsRUC response (MT v150 §9.6.3, schemas 16-17). */
export function parseConsultaRUC(xml: string, options?: ParseOptions): SifenConsRUC {
  const body = bodyAs(xml, 'consultarRUC', 'rResEnviConsRUC', options);
  const container = firstChild(body, 'xContRUC');
  const rContRUC =
    container === undefined ? undefined : (firstChild(container, 'rContRUC') ?? container);
  return {
    dCodRes: requireText(body, 'dCodRes', 'consultarRUC'),
    dMsgRes: requireText(body, 'dMsgRes', 'consultarRUC'),
    contribuyente:
      rContRUC === undefined
        ? null
        : {
            ruc: requireText(rContRUC, 'dRUCCons', 'consultarRUC'),
            razonSocial: requireText(rContRUC, 'dRazCons', 'consultarRUC'),
            estado: requireText(rContRUC, 'dCodEstCons', 'consultarRUC'),
            facturadorElectronico: parseSiNo(requireText(rContRUC, 'dRUCFactElec', 'consultarRUC')),
          },
  };
}

/**
 * siRecepEvento response (MT v150 §9.5.3, schema 14: rRetEnviEventoDe). The schema has no lote-level
 * code, so the headline `dCodRes`/`dMsgRes` is the first message of the first event result; callers
 * needing per-event outcomes must read `resultados`.
 */
export function parseEventos(xml: string, options?: ParseOptions): SifenEventosResult {
  const body = bodyAs(xml, 'enviarEventos', 'rRetEnviEventoDe', options);
  const resultados = children(body, 'gResProcEVe').map((node) => ({
    id: requireText(node, 'id', 'enviarEventos'),
    dEstRes: requireText(node, 'dEstRes', 'enviarEventos'),
    mensajes: children(node, 'gResProc').map((message) => ({
      dCodRes: requireText(message, 'dCodRes', 'enviarEventos'),
      dMsgRes: requireText(message, 'dMsgRes', 'enviarEventos'),
    })),
  }));
  const headline = resultados.at(0)?.mensajes.at(0);
  if (headline === undefined)
    throw protocolError('enviarEventos', 'no event result with a message');
  return { dCodRes: headline.dCodRes, dMsgRes: headline.dMsgRes, resultados };
}
