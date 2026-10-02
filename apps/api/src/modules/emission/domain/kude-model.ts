import type { QrEnvironment } from './qr.js';

/** MT v150 13.3: the KuDE denomination for an electronic invoice (FE). */
export const KUDE_TITLE = 'KuDE de Factura Electrónica';

/** MT v150 13.4.4: consultation portal per environment (no trailing slash, no query). */
export const KUDE_CONSULT_URL: Readonly<Record<QrEnvironment, string>> = {
  production: 'https://ekuatia.set.gov.py/consultas',
  test: 'https://ekuatia.set.gov.py/consultas-test',
};

export interface KudeItem {
  /** E701 */
  code: string;
  /** E708 */
  description: string;
  /** E710 (description of the unit of measure). */
  unit: string;
  quantity: number;
  /** PYG, integer. */
  unitPrice: number;
  /** EA002, per item, PYG. */
  discount: number;
  /** Column the line value goes to: exempt (0), 5% or 10%. */
  vatRate: 0 | 5 | 10;
  /** Line value in PYG. */
  total: number;
}

export type KudeReceiver =
  | {
      kind: 'named';
      /** D206 (RUC with DV) or D210 (identity document number). */
      document: string;
      /** D211 */
      name: string;
      address?: string;
      phone?: string;
      email?: string;
    }
  | { kind: 'unnamed' };

/** Everything a KuDE of an FE shows, taken from the signed DE (MT 13.2: nothing else). */
export interface KudeInvoice {
  environment: QrEnvironment;
  /** 44 digits. */
  cdc: string;
  /** The `dCarQR` URL of the signed document, encoded as is. */
  qrUrl: string;
  issuer: {
    name: string;
    tradeName?: string;
    activity?: string;
    address: string;
    city: string;
    /** `RUC-DV`. */
    ruc: string;
  };
  stamp: { number: string; validFrom: string; validTo: string };
  establishment: string;
  point: string;
  documentNumber: string;
  /** dFeEmiDE, Paraguay local time `YYYY-MM-DDThh:mm:ss`. */
  issuedAt: string;
  /** E602 */
  operationCondition: string;
  /** D016 */
  currency: string;
  receiver: KudeReceiver;
  /** D012 */
  transactionType: string;
  items: KudeItem[];
  totals: {
    subtotalExempt: number;
    subtotal5: number;
    subtotal10: number;
    totalOperation: number;
    totalGs: number;
    vat5: number;
    vat10: number;
    totalVat: number;
  };
}

/** MT v150 13.4.4 / section 10: the CDC is shown in eleven groups of four digits. */
export function groupCdc(cdc: string): string {
  if (!/^\d{44}$/.test(cdc)) throw new Error('CDC must be exactly 44 digits');
  return (cdc.match(/\d{4}/g) ?? []).join(' ');
}

const thousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** PYG amount with dot thousands separators. */
export function formatPyg(amount: number): string {
  return `${amount < 0 ? '-' : ''}${thousands(String(Math.abs(Math.trunc(amount))))}`;
}

/** Quantity: dot thousands, decimal comma only when fractional. */
export function formatQuantity(quantity: number): string {
  const [whole = '0', fraction] = String(quantity).split('.');
  return fraction ? `${thousands(whole)},${fraction}` : thousands(whole);
}

/** `001-001-0000001` (dEst-dPunExp-dNumDoc). */
export function formatDocumentNumber(
  establishment: string,
  point: string,
  documentNumber: string,
): string {
  return `${establishment}-${point}-${documentNumber}`;
}

/** `YYYY-MM-DD` to `DD/MM/YYYY` (MT 13.4.1 sample). */
export function formatDateDmy(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('Date must be YYYY-MM-DD');
  return `${match[3]}/${match[2]}/${match[1]}`;
}
