/** True for a real `YYYY-MM-DD` calendar date: month 13, day 32 and 02-30 are not. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  // Date.parse gives NaN for month 00/13 or day 00/32; a rolled-over date (02-30) does not round-trip.
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}
