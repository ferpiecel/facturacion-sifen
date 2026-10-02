import type { QrEnvironment } from './qr.js';

/** MT v150 13.3: the KuDE denomination for an electronic invoice (FE). */
export const KUDE_TITLE = 'KuDE de Factura Electrónica';

/** MT v150 13.4.4: consultation portal per environment (with the trailing slash of the MT). */
export const KUDE_CONSULT_URL: Readonly<Record<QrEnvironment, string>> = {
  production: 'https://ekuatia.set.gov.py/consultas/',
  test: 'https://ekuatia.set.gov.py/consultas-test/',
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
  /** D016. Amounts are PYG integers; foreign-currency KuDEs are out of scope. */
  currency: string;
  /** E644, only for credit operations. */
  installments?: number;
  /** D018 as written in the DE (decimal string), only when it applies. */
  exchangeRate?: string;
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

/** PYG amount with dot thousands separators; PYG has no decimals, so anything else is a bug upstream. */
export function formatPyg(amount: number): string {
  if (!Number.isSafeInteger(amount))
    throw new Error(`PYG amount must be a safe integer: ${String(amount)}`);
  return `${amount < 0 ? '-' : ''}${thousands(String(Math.abs(amount)))}`;
}

/** Quantity: dot thousands, decimal comma only when fractional; never exponent notation. */
export function formatQuantity(quantity: number): string {
  if (!Number.isFinite(quantity)) throw new Error('Quantity must be finite');
  const plain = quantity.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 8 });
  const [whole = '0', fraction] = plain.split('.');
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

/** The model cannot be drawn; `field` names the offender. */
export class InvalidKudeInvoiceError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid KuDE ${field}: ${reason}`);
    this.name = 'InvalidKudeInvoiceError';
  }
}

const isDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

/** Up-front checks, so a bad model fails before any PDF byte is produced. */
export function assertValidKudeInvoice(invoice: KudeInvoice): void {
  if (!/^\d{44}$/.test(invoice.cdc)) throw new InvalidKudeInvoiceError('cdc', 'expected 44 digits');
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(invoice.issuedAt) ||
    !isDate(invoice.issuedAt.slice(0, 10))
  ) {
    throw new InvalidKudeInvoiceError('issuedAt', 'expected a real YYYY-MM-DDThh:mm:ss');
  }
  if (!isDate(invoice.stamp.validFrom) || !isDate(invoice.stamp.validTo)) {
    throw new InvalidKudeInvoiceError('stamp', 'validity dates must be YYYY-MM-DD');
  }
  if (invoice.currency !== 'PYG') {
    throw new InvalidKudeInvoiceError('currency', 'only PYG is supported');
  }
  if (invoice.qrUrl === '') throw new InvalidKudeInvoiceError('qrUrl', 'required');
  if (
    invoice.installments !== undefined &&
    (!Number.isInteger(invoice.installments) || invoice.installments < 1)
  ) {
    throw new InvalidKudeInvoiceError('installments', 'must be a positive integer');
  }
}
