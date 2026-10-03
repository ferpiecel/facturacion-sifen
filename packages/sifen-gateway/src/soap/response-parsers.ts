import { SifenFaultError, SifenProtocolError } from '../errors.ts';
import type { SifenOperation } from '../port.ts';
import {
  toCdc,
  type SifenLoteReceipt,
  type SifenLoteResult,
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
