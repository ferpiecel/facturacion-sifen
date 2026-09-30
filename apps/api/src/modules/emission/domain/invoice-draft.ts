import { DEPARTMENTS } from '../../fiscal-config/domain/department.js';

/** iTiOpe (D202): 1=B2B, 2=B2C, 3=B2G, 4=B2F. */
export type OperationType = 'B2B' | 'B2C' | 'B2G' | 'B2F';

export type DraftReceiver =
  /** `isPublicEntity`: the receiver RUC belongs to an OEE. MT/NT ship no OEE registry, so the caller resolves it. */
  | { kind: 'named'; isPublicEntity: boolean }
  /** Innominado (D208 = 5). */
  | { kind: 'unnamed' };

export interface DraftItem {
  quantity: number;
  /** Unit price in PYG (integer). */
  unitPrice: number;
  vatRate: 0 | 5 | 10;
}

export interface InvoiceDraft {
  receiver: DraftReceiver;
  operationType: OperationType;
  items: DraftItem[];
  /** dRedon (F013): rounding discounted from the operation total, in PYG. */
  roundingPyg: number;
  location: { departmentCode: number };
}

export interface ValidationConfig {
  /** Innominado limit in PYG (NT 024 sets 7,000,000; earlier MT v150 text said 60,000,000). */
  unnamedThresholdPyg?: number;
}

export interface ValidationError {
  field: string;
  rule: string;
  sifenCode?: string;
  message: string;
}

export const DEFAULT_UNNAMED_THRESHOLD_PYG = 7_000_000;
const ROUNDING_STEP = 50;

/**
 * Pure pre-SIFEN validation: collects every violation. PYG amounts are integer-only and
 * rounding follows MT v150 group F (SEDECO Res. 347/2014): the total is rounded down to a
 * multiple of 50 Gs (107.437 -> 107.400), so dRedon must be in 0..49.
 */
export function validateInvoiceDraft(
  draft: InvoiceDraft,
  config: ValidationConfig,
): ValidationError[] {
  const errors: ValidationError[] = [];
  let total = 0;

  if (draft.items.length === 0) {
    errors.push({
      field: 'items',
      rule: 'items-required',
      message: 'At least one item is required',
    });
  }

  draft.items.forEach((item, i) => {
    const path = `items[${String(i)}]`;
    const validLine = item.quantity > 0 && item.unitPrice >= 0;
    if (!(item.quantity > 0)) {
      errors.push({
        field: `${path}.quantity`,
        rule: 'quantity-positive',
        message: 'Quantity must be greater than zero',
      });
    }
    // Zero is allowed (free-of-charge items); negatives are not.
    if (!(item.unitPrice >= 0)) {
      errors.push({
        field: `${path}.unitPrice`,
        rule: 'unit-price-non-negative',
        message: 'Unit price must not be negative',
      });
    }
    if (![0, 5, 10].includes(item.vatRate)) {
      errors.push({
        field: `${path}.vatRate`,
        rule: 'vat-rate',
        message: 'VAT rate must be 0, 5 or 10',
      });
    }
    if (!Number.isInteger(item.unitPrice)) {
      errors.push({
        field: `${path}.unitPrice`,
        rule: 'pyg-integer',
        message: 'PYG unit price must be an integer',
      });
    }
    const itemTotal = item.quantity * item.unitPrice;
    if (!Number.isInteger(itemTotal)) {
      errors.push({
        field: `${path}.total`,
        rule: 'pyg-integer',
        message: 'PYG item total (quantity x unit price) must be an integer',
      });
    }
    // Invalid lines never offset valid ones (they would bypass the threshold).
    if (validLine) total += itemTotal;
  });

  const net = total - draft.roundingPyg;
  if (Number.isInteger(total)) {
    const roundingOk =
      Number.isInteger(draft.roundingPyg) &&
      draft.roundingPyg >= 0 &&
      draft.roundingPyg < ROUNDING_STEP &&
      net % ROUNDING_STEP === 0;
    if (!roundingOk) {
      errors.push({
        field: 'roundingPyg',
        rule: 'rounding-multiple-of-50',
        message: 'Total must be rounded down to a multiple of 50 Gs (rounding 0..49)',
      });
    }
  }
  const threshold = config.unnamedThresholdPyg ?? DEFAULT_UNNAMED_THRESHOLD_PYG;
  // D208c / 1321 (NT 024): F014 >= threshold. Muestras medicas (D011=13) exemption is out of scope.
  if (draft.receiver.kind === 'unnamed' && net >= threshold) {
    errors.push({
      field: 'receiver',
      rule: 'unnamed-receiver-over-threshold',
      sifenCode: '1321',
      message: `Unnamed receiver not allowed when the total is ${String(threshold)} Gs or more`,
    });
  }

  // D202b / 1332 (NT 020)
  if (
    draft.receiver.kind === 'named' &&
    draft.receiver.isPublicEntity &&
    draft.operationType !== 'B2G'
  ) {
    errors.push({
      field: 'operationType',
      rule: 'public-entity-requires-b2g',
      sifenCode: '1332',
      message: 'Operation type must be B2G when the receiver is a public entity (OEE)',
    });
  }

  if (DEPARTMENTS[draft.location.departmentCode] === undefined) {
    errors.push({
      field: 'location.departmentCode',
      rule: 'department-code',
      message: 'Department code is not in the SIFEN departments table',
    });
  }

  return errors;
}
