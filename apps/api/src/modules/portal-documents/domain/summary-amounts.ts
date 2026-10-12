const SCALE = 8;

function toUnits(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole + fraction.padEnd(SCALE, '0').slice(0, SCALE));
}

/** Exact sum of stored numeric texts (up to 8 decimals), as a numeric text. */
export function addAmounts(a: string, b: string): string {
  const sum = toUnits(a) + toUnits(b);
  const text = sum.toString().padStart(SCALE + 1, '0');
  return `${text.slice(0, -SCALE)}.${text.slice(-SCALE)}`;
}
