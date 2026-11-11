import { Decimal } from './decimal.js';

/** Structural views of the draft, so this file does not import `invoice-draft.ts` (no cycle). */
interface LineLike {
  quantity: number;
  unitPrice: number;
  vatRate?: number;
}
interface DraftLike {
  items: readonly LineLike[];
  roundingPyg: number;
}

/** Digits the numeric(23,8) columns and the XSD hold: 15 integer, 8 decimal (ADR-0018). */
export const AMOUNT_INTEGER_DIGITS = 15;
export const AMOUNT_DECIMALS = 8;

/** A JSON number as an exact decimal, or `undefined` when it cannot be read exactly. */
export function parseAmount(value: number): Decimal | undefined {
  const parsed = Decimal.parse(value);
  return parsed.ok ? parsed.value : undefined;
}

/** A constant from trusted source text; throws on malformed input. */
export function amount(text: string): Decimal {
  const parsed = Decimal.parse(text);
  if (!parsed.ok) throw new Error(`Invalid amount constant: ${text}`);
  return parsed.value;
}

export function fitsAmount(value: Decimal): boolean {
  return value.fitsIn(AMOUNT_INTEGER_DIGITS, AMOUNT_DECIMALS);
}

/**
 * Exact `quantity x unitPrice` (E727), or `undefined` when an operand is not exact or the
 * product needs more than 8 decimals or 15 integer digits.
 */
export function lineTotal(item: LineLike): Decimal | undefined {
  const quantity = parseAmount(item.quantity);
  const unitPrice = parseAmount(item.unitPrice);
  const product = quantity && unitPrice ? quantity.multiplyExact(unitPrice) : undefined;
  return product && fitsAmount(product) ? product : undefined;
}

/** Gross total (F008) and net total (F014 = F008 - F013). Requires a validated draft. */
export function invoiceTotals(draft: DraftLike): { gross: Decimal; net: Decimal } {
  let gross = Decimal.zero();
  for (const item of draft.items) {
    const line = lineTotal(item);
    const sum = line ? gross.add(line) : undefined;
    if (!sum || !fitsAmount(sum)) throw new Error('Invoice totals require a validated draft');
    gross = sum;
  }
  const rounding = parseAmount(draft.roundingPyg);
  if (!rounding) throw new Error('Invoice totals require a validated draft');
  const net = gross.subtract(rounding);
  if (!fitsAmount(net)) throw new Error('Invoice totals require a validated draft');
  return { gross, net };
}
