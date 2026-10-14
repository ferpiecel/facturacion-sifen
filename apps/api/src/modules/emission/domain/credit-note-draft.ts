import { Decimal } from './decimal.js';
import {
  validateInvoiceDraft,
  type DraftItem,
  type DraftReceiver,
  type InvoiceDraft,
  type OperationType,
  type ValidationConfig,
  type ValidationError,
} from './invoice-draft.js';
import { invoiceTotals } from './invoice-totals.js';

/** E401/E402 (MT v150, group E5): the closed table of reasons with their fixed descriptions (1452). */
export const CREDIT_NOTE_REASONS = {
  1: 'Devolución y Ajuste de precios',
  2: 'Devolución',
  3: 'Descuento',
  4: 'Bonificación',
  5: 'Crédito incobrable',
  6: 'Recupero de costo',
  7: 'Recupero de gasto',
  8: 'Ajuste de precio',
} as const;

export type CreditNoteReasonCode = keyof typeof CREDIT_NOTE_REASONS;

/**
 * Statuses of the associated FE that SIFEN has approved (ADR-0019 D6: `dEstRes` "Aprobado con
 * observación" is an approval). A constant so the Prevalidador (T0) can change it in one line.
 */
export const CREDITABLE_STATUSES: readonly string[] = ['approved', 'approved_with_observations'];

const GONE_STATUSES: readonly string[] = ['cancelled', 'number_voided'];

/** H004 / 2414: an NCE is associated to an FE only, whose CDC carries the document type `01`. */
const INVOICE_CDC = /^01[0-9]{42}$/;

/** What the NCE takes from the FE it credits (receiver, state, money). */
export interface AssociatedInvoiceFacts {
  receiver: DraftReceiver;
  operationType: OperationType;
  location: { departmentCode?: number };
  status: string;
  currency: string;
  totalAmount: string;
  /** F014 of the other NCE of that FE that still count (ADR-0019 D5). Exact decimal texts. */
  creditedAmount: string;
}

export interface CreditNoteDraft {
  associatedCdc: string;
  reasonCode: number;
  items: DraftItem[];
  roundingPyg: number;
}

/** Fields of the invoice rules that the credit note shares. */
const SHARED_FIELDS = /^(items|total|roundingPyg)(\.|\[|$)/;

/** H004d / 2417: the credits of an FE, this one included, must not exceed its F014. */
export function creditNoteSumRule(
  invoiceTotal: Decimal,
  alreadyCredited: Decimal,
  creditNet: Decimal,
): ValidationError | undefined {
  if (alreadyCredited.add(creditNet).compare(invoiceTotal) <= 0) return undefined;
  return {
    field: 'items',
    rule: 'credit-note-sum-exceeds-invoice',
    sifenCode: '2417',
    message: 'The sum of the credit notes must not exceed the total of the associated invoice',
  };
}

/** H004f / 2438: same operation currency. Only PYG exists, so this is a guard for multi-currency. */
export function creditNoteCurrencyRule(invoiceCurrency: string): ValidationError | undefined {
  if (invoiceCurrency === 'PYG') return undefined;
  return {
    field: 'associatedCdc',
    rule: 'credit-note-currency-mismatch',
    sifenCode: '2438',
    message: 'The credit note currency must match the one of the associated invoice',
  };
}

/**
 * Pure pre-SIFEN validation of an NCE (ADR-0019). `invoice` is `undefined` when the CDC is not one
 * of the tenant's documents. Items, totals and rounding reuse the invoice rules (F014 = F008 - F013,
 * 2365); the receiver rules do not apply because the receiver is the FE's. Collects every violation.
 */
export function validateCreditNoteDraft(
  draft: CreditNoteDraft,
  invoice: AssociatedInvoiceFacts | undefined,
  config: ValidationConfig,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Object.hasOwn(CREDIT_NOTE_REASONS, draft.reasonCode)) {
    errors.push({
      field: 'reasonCode',
      rule: 'credit-note-reason',
      sifenCode: '1452',
      message: 'The reason must be one of the eight codes of E401 (1 to 8)',
    });
  }

  let creditable = false;
  if (!INVOICE_CDC.test(draft.associatedCdc)) {
    errors.push({
      field: 'associatedCdc',
      rule: 'associated-document-not-invoice',
      sifenCode: '2414',
      message: 'The associated document must be an electronic invoice (CDC type 01)',
    });
  } else if (!invoice) {
    errors.push({
      field: 'associatedCdc',
      rule: 'associated-document-not-found',
      sifenCode: '2403',
      message: 'The associated invoice does not exist',
    });
  } else if (GONE_STATUSES.includes(invoice.status)) {
    errors.push({
      field: 'associatedCdc',
      rule: 'associated-document-cancelled',
      sifenCode: '2404',
      message: 'The associated invoice is cancelled',
    });
  } else if (!CREDITABLE_STATUSES.includes(invoice.status)) {
    errors.push({
      field: 'associatedCdc',
      rule: 'associated-document-not-approved',
      message: 'The associated invoice has not been approved by SIFEN yet',
    });
  } else {
    creditable = true;
    if (invoice.receiver.kind === 'unnamed') {
      errors.push({
        field: 'associatedCdc',
        rule: 'credit-note-unnamed-receiver',
        sifenCode: '1331',
        message: 'A credit note cannot be issued for an invoice with an unnamed receiver',
      });
    }
    const currency = creditNoteCurrencyRule(invoice.currency);
    if (currency) errors.push(currency);
  }

  const itemErrors = validateInvoiceDraft(toInvoiceShape(draft, invoice), config).filter((e) =>
    SHARED_FIELDS.test(e.field),
  );
  errors.push(...itemErrors);

  if (creditable && invoice && itemErrors.length === 0) {
    const invoiceTotal = Decimal.parse(invoice.totalAmount);
    const credited = Decimal.parse(invoice.creditedAmount);
    if (invoiceTotal.ok && credited.ok) {
      const sum = creditNoteSumRule(invoiceTotal.value, credited.value, invoiceTotals(draft).net);
      if (sum) errors.push(sum);
    }
  }
  return errors;
}

/** The draft as an invoice, with the FE's receiver, only to reuse the item and rounding rules. */
function toInvoiceShape(
  draft: CreditNoteDraft,
  invoice: AssociatedInvoiceFacts | undefined,
): InvoiceDraft {
  return {
    receiver: invoice?.receiver ?? { kind: 'named', isPublicEntity: false },
    operationType: invoice?.operationType ?? 'B2B',
    items: draft.items,
    roundingPyg: draft.roundingPyg,
    location: invoice?.location ?? {},
  };
}
