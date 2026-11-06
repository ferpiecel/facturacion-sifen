import { ParseOption, XmlDocument, type XmlElement, type XmlNode } from 'libxml2-wasm';
import {
  MalformedSifenXmlError,
  SUPPORTED_SIFEN_DOCUMENT_TYPES,
  SifenXmlTooLargeError,
  UnsupportedDocumentTypeError,
  type ParsedPaymentCondition,
  type ParsedSifenDocument,
  type ParsedSifenItem,
  type SifenXmlParser,
} from '../../application/ports/sifen-xml-parser.port.js';

/** 2 MiB: real documents are 4-12 KB; the cap only has to stop abuse. */
export const DEFAULT_SIFEN_XML_MAX_BYTES = 2 * 1024 * 1024;

export interface Libxml2SifenXmlParserOptions {
  readonly maxBytes?: number;
}

/**
 * Document type declarations of any kind. SIFEN documents never carry a DTD, so refusing them
 * outright closes XXE and entity-expansion (billion laughs) instead of limiting them. The scan runs
 * on the raw bytes, before libxml2 sees the input.
 */
const DTD_DECLARATION = /<!(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:$|T)/;
const PARSE_OPTIONS = ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NONET;
const VAT_RATES = new Set([0, 5, 10]);

/** Namespace-agnostic child lookup: SIFEN documents appear with and without the default namespace. */
function step(path: string): string {
  return path
    .split('/')
    .map((name) => `*[local-name()='${name}']`)
    .join('/');
}

function node(from: XmlNode, path: string): XmlNode | null {
  return from.get(step(path));
}

function optionalText(from: XmlNode, path: string): string | null {
  const found = node(from, path);
  const text = found?.content.trim();
  return text === undefined || text === '' ? null : text;
}

function requiredText(from: XmlNode, path: string): string {
  const text = optionalText(from, path);
  if (text === null) throw new MalformedSifenXmlError('missing_element', path);
  return text;
}

function requiredNode(from: XmlNode, path: string): XmlNode {
  const found = node(from, path);
  if (found === null) throw new MalformedSifenXmlError('missing_element', path);
  return found;
}

function decimal(value: string, path: string): string {
  if (!DECIMAL.test(value)) throw new MalformedSifenXmlError('invalid_value', path);
  return value;
}

function requiredDecimal(from: XmlNode, path: string): string {
  return decimal(requiredText(from, path), path);
}

function optionalDecimal(from: XmlNode, path: string): string {
  const text = optionalText(from, path);
  return text === null ? '0' : decimal(text, path);
}

function integer(value: string, path: string): number {
  if (!/^\d{1,9}$/.test(value)) throw new MalformedSifenXmlError('invalid_value', path);
  return Number(value);
}

function toBytes(xml: Uint8Array | string, maxBytes: number): Uint8Array {
  const length = typeof xml === 'string' ? Buffer.byteLength(xml, 'utf8') : xml.byteLength;
  if (length > maxBytes) throw new SifenXmlTooLargeError(length, maxBytes);
  return typeof xml === 'string' ? Buffer.from(xml, 'utf8') : xml;
}

/** UTF-16/32 (BOM or NUL bytes) and EBCDIC cannot be scanned for a DTD, so they are refused. */
function assertScannableEncoding(bytes: Uint8Array): void {
  const [a = 1, b = 1, c = 1, d = 1] = bytes;
  const utf16Bom = (a === 0xfe && b === 0xff) || (a === 0xff && b === 0xfe);
  const nulBytes = a === 0 || b === 0 || c === 0 || d === 0;
  const ebcdic = a === 0x4c && b === 0x6f && c === 0xa7 && d === 0x94;
  if (utf16Bom || nulBytes || ebcdic) throw new MalformedSifenXmlError('unsupported_encoding');
}

function findRde(doc: XmlDocument): XmlElement | null {
  const found = doc.get("//*[local-name()='rDE']");
  return found === null ? null : (found as XmlElement);
}

function mapItem(item: XmlNode): ParsedSifenItem {
  const value = requiredNode(item, 'gValorItem');
  const vat = requiredNode(item, 'gCamIVA');
  const rate = integer(requiredText(vat, 'dTasaIVA'), 'dTasaIVA');
  if (!VAT_RATES.has(rate)) throw new MalformedSifenXmlError('invalid_value', 'dTasaIVA');
  const netTotal = optionalText(value, 'gValorRestaItem/dTotOpeItem');
  return {
    description: requiredText(item, 'dDesProSer'),
    quantity: requiredDecimal(item, 'dCantProSer'),
    unitPrice: requiredDecimal(value, 'dPUniProSer'),
    discount: optionalDecimal(value, 'gValorRestaItem/dDescItem'),
    taxRate: rate,
    taxBase: optionalDecimal(vat, 'dBasGravIVA'),
    taxAmount: optionalDecimal(vat, 'dLiqIVAItem'),
    lineTotal:
      netTotal === null
        ? requiredDecimal(value, 'dTotBruOpeItem')
        : decimal(netTotal, 'dTotOpeItem'),
  };
}

function paymentCondition(de: XmlNode): ParsedPaymentCondition {
  switch (requiredText(de, 'gDtipDE/gCamCond/iCondOpe')) {
    case '1':
      return 'cash';
    case '2':
      return 'credit';
    default:
      throw new MalformedSifenXmlError('invalid_value', 'iCondOpe');
  }
}

/** `dPlazoCre` is free text such as "30 días"; the leading number is the term. */
function creditTermDays(de: XmlNode): number | null {
  const text = optionalText(de, 'gDtipDE/gCamCond/gPagCred/dPlazoCre');
  const match = text === null ? null : /^(\d{1,5})/.exec(text);
  return match === null ? null : Number(match[1]);
}

function mapDocument(rde: XmlNode): ParsedSifenDocument {
  const de = requiredNode(rde, 'DE');
  const cdc = (de as XmlElement).attr('Id')?.value.trim();
  if (cdc === undefined || cdc === '') throw new MalformedSifenXmlError('missing_element', 'DE@Id');

  const documentType = integer(requiredText(de, 'gTimb/iTiDE'), 'iTiDE');
  if (!SUPPORTED_SIFEN_DOCUMENT_TYPES.includes(documentType)) {
    throw new UnsupportedDocumentTypeError(documentType);
  }

  const issuer = requiredNode(de, 'gDatGralOpe/gEmis');
  const receiver = node(de, 'gDatGralOpe/gDatRec');
  const totals = requiredNode(de, 'gTotSub');
  const issuedAt = requiredText(de, 'gDatGralOpe/dFeEmiDE');
  const issueDate = DATE_PREFIX.exec(issuedAt)?.[1];
  if (issueDate === undefined) throw new MalformedSifenXmlError('invalid_value', 'dFeEmiDE');

  const establishment = requiredText(de, 'gTimb/dEst');
  const expeditionPoint = requiredText(de, 'gTimb/dPunExp');
  const number = requiredText(de, 'gTimb/dNumDoc');
  const items = de.find(step('gDtipDE/gCamItem'));
  if (items.length === 0) throw new MalformedSifenXmlError('missing_element', 'gCamItem');

  return {
    cdc,
    documentType,
    issuer: {
      ruc: requiredText(issuer, 'dRucEm'),
      dv: optionalText(issuer, 'dDVEmi'),
      legalName: requiredText(issuer, 'dNomEmi'),
    },
    receiver: {
      ruc: receiver === null ? null : optionalText(receiver, 'dRucRec'),
      dv: receiver === null ? null : optionalText(receiver, 'dDVRec'),
      name: receiver === null ? null : optionalText(receiver, 'dNomRec'),
    },
    establishment,
    expeditionPoint,
    number,
    documentNumber: `${establishment}-${expeditionPoint}-${number}`,
    issueDate,
    currency: optionalText(de, 'gDatGralOpe/gOpeCom/cMoneOpe') ?? 'PYG',
    paymentCondition: paymentCondition(de),
    creditTermDays: creditTermDays(de),
    totals: {
      exempt: requiredDecimal(totals, 'dSubExe'),
      exonerated: optionalDecimal(totals, 'dSubExo'),
      taxable5: optionalDecimal(totals, 'dBaseGrav5'),
      taxable10: optionalDecimal(totals, 'dBaseGrav10'),
      vat5: requiredDecimal(totals, 'dIVA5'),
      vat10: requiredDecimal(totals, 'dIVA10'),
      total: requiredDecimal(totals, 'dTotGralOpe'),
    },
    items: items.map(mapItem),
    authorizationProtocol: optionalText(rde, 'dProtAut'),
  };
}

/**
 * SIFEN `rDE` parser on libxml2 (wasm, already used by `@sifen/sifen-xsd`). Hardened for untrusted
 * input: byte cap, DTD/entity declarations refused, external loading disabled, and error messages
 * that never include document content.
 */
export class Libxml2SifenXmlParser implements SifenXmlParser {
  private readonly maxBytes: number;

  constructor(options: Libxml2SifenXmlParserOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_SIFEN_XML_MAX_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive integer');
    }
    this.maxBytes = maxBytes;
  }

  parse(xml: Uint8Array | string): ParsedSifenDocument {
    const bytes = toBytes(xml, this.maxBytes);
    assertScannableEncoding(bytes);
    if (DTD_DECLARATION.test(Buffer.from(bytes).toString('latin1'))) {
      throw new MalformedSifenXmlError('dtd_forbidden');
    }

    let doc: XmlDocument;
    try {
      doc = XmlDocument.fromBuffer(bytes, { option: PARSE_OPTIONS });
    } catch {
      throw new MalformedSifenXmlError('not_well_formed');
    }
    try {
      const rde = findRde(doc);
      if (rde === null) throw new MalformedSifenXmlError('missing_element', 'rDE');
      return mapDocument(rde);
    } finally {
      doc.dispose();
    }
  }
}
