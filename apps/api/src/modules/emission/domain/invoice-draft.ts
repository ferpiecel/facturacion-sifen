import { DEPARTMENTS } from '../../fiscal-config/domain/department.js';
import { Decimal } from './decimal.js';
import { amount, fitsAmount, parseAmount } from './invoice-totals.js';

/** iTiOpe (D202): 1=B2B, 2=B2C, 3=B2G, 4=B2F. */
export type OperationType = 'B2B' | 'B2C' | 'B2G' | 'B2F';

/** Receiver address block (D213-D223): optional, except for B2F (D202 = 4). */
export interface DraftReceiverAddress {
  /** dDirRec (D213). */
  street: string;
  /** dNumCasRec (D218): mandatory when the address is informed. */
  houseNumber?: string;
  /** cCiuRec (D223): mandatory when the address is informed, unless B2F. */
  cityCode?: number;
}

export type DraftReceiver =
  /** `isPublicEntity`: the receiver RUC belongs to an OEE. MT/NT ship no OEE registry, so the caller resolves it. */
  | { kind: 'named'; isPublicEntity: boolean; address?: DraftReceiverAddress }
  /** Innominado (D208 = 5). */
  | { kind: 'unnamed' };

export interface DraftItem {
  /** Up to 10 integer and 8 decimal digits (NT 023). */
  quantity: number;
  /** Unit price in PYG: up to 15 integer and 8 decimal digits. */
  unitPrice: number;
  vatRate: 0 | 5 | 10;
}

export interface InvoiceDraft {
  receiver: DraftReceiver;
  operationType: OperationType;
  items: DraftItem[];
  /** dRedon (F013): rounding discounted from the operation total, in PYG (0 up to 49.9999). */
  roundingPyg: number;
  /** cDepRec (D219): the receiver department; mandatory with an address, unless B2F. */
  location: { departmentCode?: number };
}

export interface ValidationConfig {
  /** Innominado limit in PYG (NT 024 sets 7,000,000; earlier MT v150 text said 60,000,000). */
  unnamedThresholdPyg?: number;
  /**
   * HU-E5-09: accept decimal prices, quantities and rounding. Off by default (PYG integers, as
   * before) until the XML, QR and KuDE handle decimals (T5 to T7); the tests run with it on.
   */
  allowDecimals?: boolean;
}

export interface ValidationError {
  field: string;
  rule: string;
  sifenCode?: string;
  message: string;
}

export const DEFAULT_UNNAMED_THRESHOLD_PYG = 7_000_000;
const ROUNDING_STEP = amount('50');
const DEFAULT_THRESHOLD_AMOUNT = amount(String(DEFAULT_UNNAMED_THRESHOLD_PYG));
const ROUNDING_DECIMALS = 4;
const QUANTITY_INTEGER_DIGITS = 10;
const DIGITS = { integer: 15, decimals: 8 };
/** Largest PYG amount the numeric(23,8) columns hold: 15 integer digits. */
export const MAX_AMOUNT_PYG = 999_999_999_999_999;

/**
 * Pure pre-SIFEN validation: collects every violation. Amounts are exact decimals (ADR-0018):
 * up to 15 integer and 8 decimal digits, no `number` arithmetic. Rounding follows MT v150
 * group F (SEDECO Res. 347/2014): the total is rounded down to a multiple of 50 Gs
 * (107.437 -> 107.400), so dRedon must be in 0..49.9999.
 */
export function validateInvoiceDraft(
  draft: InvoiceDraft,
  config: ValidationConfig,
): ValidationError[] {
  const errors: ValidationError[] = [];
  let total = Decimal.zero();
  const state = { priceOverflow: false };

  if (draft.items.length === 0) {
    errors.push({
      field: 'items',
      rule: 'items-required',
      message: 'At least one item is required',
    });
  }

  draft.items.forEach((item, i) => {
    const path = `items[${String(i)}]`;
    const quantity = parseAmount(item.quantity);
    const unitPrice = parseAmount(item.unitPrice);
    // A non-finite number is "not positive" (legacy rule); any other unreadable one is imprecise.
    if (!(item.quantity > 0)) {
      errors.push({
        field: `${path}.quantity`,
        rule: 'quantity-positive',
        message: 'Quantity must be greater than zero',
      });
    } else if (!quantity?.fitsIn(QUANTITY_INTEGER_DIGITS, DIGITS.decimals)) {
      errors.push({
        field: `${path}.quantity`,
        rule: 'quantity-precision',
        message: 'Quantity allows up to 10 integer and 8 decimal digits',
      });
    }
    // Zero is allowed (free-of-charge items); negatives are not.
    if (!(item.unitPrice >= 0)) {
      errors.push({
        field: `${path}.unitPrice`,
        rule: 'unit-price-non-negative',
        message: 'Unit price must not be negative',
      });
    } else if (!unitPrice?.fitsIn(DIGITS.integer, DIGITS.decimals)) {
      errors.push({
        field: `${path}.unitPrice`,
        rule: 'unit-price-precision',
        message: 'Unit price allows up to 15 integer and 8 decimal digits',
      });
      // Keep the pre-decimal contract: a price beyond the column is also an amount-range error.
      if (Math.abs(item.unitPrice) > MAX_AMOUNT_PYG) {
        state.priceOverflow = true;
        errors.push({
          field: `${path}.total`,
          rule: 'amount-range',
          message: `Item total must not exceed ${String(MAX_AMOUNT_PYG)} Gs`,
        });
      }
    }
    if (![0, 5, 10].includes(item.vatRate)) {
      errors.push({
        field: `${path}.vatRate`,
        rule: 'vat-rate',
        message: 'VAT rate must be 0, 5 or 10',
      });
    }
    if (!quantity || !unitPrice || !(item.quantity > 0) || !(item.unitPrice >= 0)) return;
    if (!quantity.fitsIn(QUANTITY_INTEGER_DIGITS, DIGITS.decimals)) return;
    if (!unitPrice.fitsIn(DIGITS.integer, DIGITS.decimals)) return;
    const product = quantity.multiplyExact(unitPrice);
    // Lines with a valid quantity and price count even when flagged, so they cannot bypass the threshold.
    if (product) total = total.add(product);
    if (!config.allowDecimals) {
      if (unitPrice.decimalPlaces() > 0) {
        errors.push({
          field: `${path}.unitPrice`,
          rule: 'pyg-integer',
          message: 'PYG unit price must be an integer',
        });
      }
      if (product && product.decimalPlaces() > 0) {
        errors.push({
          field: `${path}.total`,
          rule: 'pyg-integer',
          message: 'PYG item total (quantity x unit price) must be an integer',
        });
        return;
      }
    }
    if (!product) {
      errors.push({
        field: `${path}.total`,
        rule: 'line-total-precision',
        message: 'Item total (quantity x unit price) must not need more than 8 decimals',
      });
      return;
    }
    if (!fitsAmount(product)) {
      errors.push({
        field: `${path}.total`,
        rule: 'amount-range',
        message: `Item total must not exceed ${String(MAX_AMOUNT_PYG)} Gs`,
      });
      return;
    }
  });

  // Lines are non-negative, so the running total only grows: checking once at the end is enough.
  const totalInRange = fitsAmount(total) && !state.priceOverflow;
  if (!totalInRange) {
    errors.push({
      field: 'total',
      rule: 'amount-range',
      message: `Invoice total must not exceed ${String(MAX_AMOUNT_PYG)} Gs`,
    });
  }
  const rounding = parseAmount(draft.roundingPyg);
  const net = rounding ? total.subtract(rounding) : total;
  if (totalInRange && (config.allowDecimals || total.decimalPlaces() === 0)) {
    if (!isValidRounding(total, rounding, config.allowDecimals ? ROUNDING_DECIMALS : 0)) {
      errors.push({
        field: 'roundingPyg',
        rule: 'rounding-multiple-of-50',
        message: 'Total must be rounded down to a multiple of 50 Gs (rounding 0..49.9999)',
      });
    }
  }
  const threshold = config.unnamedThresholdPyg ?? DEFAULT_UNNAMED_THRESHOLD_PYG;
  const thresholdAmount = parseAmount(threshold) ?? DEFAULT_THRESHOLD_AMOUNT;
  // D208c / 1321 (NT 024): F014 >= threshold. Muestras medicas (D011=13) exemption is out of scope.
  if (draft.receiver.kind === 'unnamed' && net.compare(thresholdAmount) >= 0) {
    errors.push({
      field: 'receiver',
      rule: 'unnamed-receiver-over-threshold',
      sifenCode: '1321',
      message: `Unnamed receiver not allowed when the total is ${String(threshold)} Gs or more`,
    });
  }

  // D208b / 1319: innominado (D208 = 5) is only valid for B2C (D202 = 2).
  if (draft.receiver.kind === 'unnamed' && draft.operationType !== 'B2C') {
    errors.push({
      field: 'operationType',
      rule: 'unnamed-receiver-requires-b2c',
      sifenCode: '1319',
      message: 'An unnamed receiver is only allowed in B2C operations',
    });
  }

  // MVP (PO decision 2026-10-14): B2G and B2F cannot be built yet (xmlgen needs public
  // procurement data or a foreign receiver), so they are rejected before any number is consumed.
  const unsupportedOperation = draft.operationType === 'B2G' || draft.operationType === 'B2F';
  if (unsupportedOperation) {
    errors.push({
      field: 'operationType',
      rule: 'operation-type-not-supported',
      message: `El tipo de operación ${draft.operationType} no está soportado todavía`,
    });
  }

  // D202b / 1332 (NT 020). A public-entity receiver needs B2G, which is unsupported for now, so
  // it cannot be invoiced at all. Skipped with B2G/B2F: they already carry the error above.
  if (draft.receiver.kind === 'named' && draft.receiver.isPublicEntity && !unsupportedOperation) {
    errors.push({
      field: 'operationType',
      rule: 'public-entity-requires-b2g',
      sifenCode: '1332',
      message:
        'Un receptor entidad pública (OEE) requiere B2G, que no está soportado todavía: no se puede facturar',
    });
  }

  validateReceiverAddress(draft, errors);

  return errors;
}

/** dRedon in 0 up to 49.9999 (4 decimals) and total - dRedon a multiple of 50 Gs. */
function isValidRounding(total: Decimal, rounding: Decimal | undefined, decimals: number): boolean {
  if (!rounding || rounding.isNegative() || rounding.compare(ROUNDING_STEP) >= 0) return false;
  if (!rounding.fitsIn(2, decimals)) return false;
  const net = total.subtract(rounding);
  // The quotient is truncated at 8 decimals, so it must also be whole and multiply back exactly.
  const quotient = net.divide(ROUNDING_STEP, 'truncate');
  return quotient.decimalPlaces() === 0 && quotient.multiply(ROUNDING_STEP, 'truncate').equals(net);
}

/**
 * Receiver address rules (MT v150 D213-D223, NT 003 1324/1327, NT 014 4470/4478): the block is
 * all or nothing; B2F requires it and forbids department and city.
 */
function validateReceiverAddress(draft: InvoiceDraft, errors: ValidationError[]): void {
  const address = draft.receiver.kind === 'named' ? draft.receiver.address : undefined;
  const { departmentCode } = draft.location;
  const isB2f = draft.operationType === 'B2F';

  if (departmentCode !== undefined && DEPARTMENTS[departmentCode] === undefined) {
    errors.push({
      field: 'location.departmentCode',
      rule: 'department-code',
      message: 'Department code is not in the SIFEN departments table',
    });
  }

  // Legacy clients always sent the department with an unnamed receiver: it is ignored, never
  // rejected and never informed in the XML.
  if (draft.receiver.kind === 'unnamed' && !isB2f) return;

  if (address === undefined) {
    if (isB2f) {
      errors.push({
        field: 'receiver.address',
        rule: 'receiver-address-required',
        sifenCode: '4478',
        message: 'The receiver address is required for B2F',
      });
    } else if (departmentCode !== undefined) {
      errors.push({
        field: 'receiver.address',
        rule: 'receiver-address-required',
        message: 'The receiver department and city require the receiver address',
      });
    }
    return;
  }

  if (address.houseNumber === undefined) {
    errors.push({
      field: 'receiver.houseNumber',
      rule: 'receiver-house-number-required',
      sifenCode: '4470',
      message: 'The house number is required when the receiver address is informed',
    });
  }
  if (isB2f) {
    if (departmentCode !== undefined) {
      errors.push({
        field: 'location.departmentCode',
        rule: 'receiver-department-not-allowed',
        message: 'The receiver department must not be informed for B2F',
      });
    }
    if (address.cityCode !== undefined) {
      errors.push({
        field: 'receiver.cityCode',
        rule: 'receiver-city-not-allowed',
        message: 'The receiver city must not be informed for B2F',
      });
    }
    return;
  }
  if (departmentCode === undefined) {
    errors.push({
      field: 'location.departmentCode',
      rule: 'receiver-department-required',
      sifenCode: '1324',
      message: 'The receiver department is required when the address is informed',
    });
  }
  if (address.cityCode === undefined) {
    errors.push({
      field: 'receiver.cityCode',
      rule: 'receiver-city-required',
      sifenCode: '1327',
      message: 'The receiver city is required when the address is informed',
    });
  }
}
