const GROUPED_INTEGER = new Intl.NumberFormat('es-PY', {
  maximumFractionDigits: 0,
  useGrouping: true,
});

/**
 * Formats Guaraníes as in the Stitch screens: no decimals, dot thousands
 * separator and the ₲ sign (`₲ 12.850.000`, `-₲ 650.000`). Sign and symbol are
 * built here so the output does not depend on the runtime's ICU data.
 */
export function formatPYG(amount: number): string {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`Cannot format a non-finite amount: ${String(amount)}`);
  }
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}₲ ${GROUPED_INTEGER.format(Math.abs(rounded))}`;
}
