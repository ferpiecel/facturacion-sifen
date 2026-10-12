/** `110000.00000000` -> `110000`, `10.50000000` -> `10.5`. */
export function trimDecimals(amount: string): string {
  return amount.includes('.') ? amount.replace(/\.?0+$/, '') : amount;
}

export function hasObservations(status: string): boolean {
  return status === 'approved_with_observations';
}
