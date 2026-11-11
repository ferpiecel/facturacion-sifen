import type { ReceivedTotals } from '../../domain/received-document-validation.js';

/** iTiDE codes the reception parser ingests. Only the electronic invoice (1) has a real golden. */
export const SUPPORTED_SIFEN_DOCUMENT_TYPES: readonly number[] = [1];

export type ParsedPaymentCondition = 'cash' | 'credit';

export interface ParsedSifenIssuer {
  /** RUC base without check digit. */
  readonly ruc: string;
  readonly dv: string | null;
  readonly legalName: string;
}

export interface ParsedSifenReceiver {
  /** RUC base without check digit; `null` for receivers identified otherwise (e.g. consumer). */
  readonly ruc: string | null;
  readonly dv: string | null;
  readonly name: string | null;
}

/** One `gCamItem`. Money and quantities are decimal strings, never `number`. */
export interface ParsedSifenItem {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discount: string;
  /** VAT rate in percent as declared by the issuer (0, 5 or 10). */
  readonly taxRate: number;
  readonly taxBase: string;
  readonly taxAmount: string;
  /** `dTotOpeItem`, falling back to `dTotBruOpeItem`. */
  readonly lineTotal: string;
}

export interface ParsedSifenDocument {
  readonly cdc: string;
  /** iTiDE. */
  readonly documentType: number;
  readonly issuer: ParsedSifenIssuer;
  readonly receiver: ParsedSifenReceiver;
  readonly establishment: string;
  readonly expeditionPoint: string;
  readonly number: string;
  /** `EEE-PPP-NNNNNNN`. */
  readonly documentNumber: string;
  /** `YYYY-MM-DD`, taken from `dFeEmiDE`. */
  readonly issueDate: string;
  readonly currency: string;
  readonly paymentCondition: ParsedPaymentCondition;
  readonly creditTermDays: number | null;
  readonly totals: ReceivedTotals;
  readonly items: readonly ParsedSifenItem[];
  /** `dProtAut` when the document carries the authorization protocol. */
  readonly authorizationProtocol: string | null;
}

export type MalformedSifenXmlCode =
  | 'not_well_formed'
  | 'unsupported_encoding'
  | 'dtd_forbidden'
  | 'missing_element'
  | 'invalid_value';

/** The bytes are not a usable `rDE`. The message never carries document content. */
export class MalformedSifenXmlError extends Error {
  constructor(
    readonly code: MalformedSifenXmlCode,
    readonly detail?: string,
  ) {
    super(
      detail === undefined
        ? `malformed SIFEN XML: ${code}`
        : `malformed SIFEN XML: ${code} (${detail})`,
    );
    this.name = 'MalformedSifenXmlError';
  }
}

/** Well-formed `rDE` whose iTiDE is outside {@link SUPPORTED_SIFEN_DOCUMENT_TYPES}. */
export class UnsupportedDocumentTypeError extends Error {
  constructor(readonly documentType: number) {
    super(`unsupported SIFEN document type: iTiDE ${String(documentType)}`);
    this.name = 'UnsupportedDocumentTypeError';
  }
}

export class SifenXmlTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(`SIFEN XML is ${String(byteLength)} bytes, above the ${String(maxBytes)} byte limit`);
    this.name = 'SifenXmlTooLargeError';
  }
}

export interface SifenXmlParser {
  /**
   * Parses a SIFEN `rDE`. Throws {@link SifenXmlTooLargeError}, {@link MalformedSifenXmlError} or
   * {@link UnsupportedDocumentTypeError}; never any other error for bad input.
   */
  parse(xml: Uint8Array | string): ParsedSifenDocument;
}
