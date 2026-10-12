const PARAGUAY_TIME_ZONE = 'America/Asuncion';
const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
/** The longest period the summary accepts, both bounds included. */
export const MAX_SUMMARY_DAYS = 366;

/** A summary query the caller sent is not valid; the message is safe to show. */
export class InvalidSummaryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSummaryQueryError';
  }
}

/** Inclusive Asuncion calendar days (`YYYY-MM-DD`) and the same-length window right before `from`. */
export interface SummaryPeriod {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

/** Today's calendar day in Paraguay time. */
export function asuncionToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PARAGUAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

function dayOf(number: number): string {
  return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

function day(raw: Record<string, unknown>, name: string): string | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new InvalidSummaryQueryError(`${name} must be a single value`);
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid) throw new InvalidSummaryQueryError(`${name} must be a YYYY-MM-DD date`);
  return value;
}

/**
 * Both bounds are optional: `to` defaults to today and `from` to 29 days before `to` (30 days in all).
 * @throws InvalidSummaryQueryError for a bad date, `from` after `to`, or more than {@link MAX_SUMMARY_DAYS} days.
 */
export function resolveSummaryPeriod(raw: Record<string, unknown>, today: string): SummaryPeriod {
  const to = day(raw, 'to') ?? today;
  const from = day(raw, 'from') ?? dayOf(dayNumber(to) - (DEFAULT_DAYS - 1));
  const length = dayNumber(to) - dayNumber(from) + 1;
  if (length < 1) throw new InvalidSummaryQueryError('from must not be after to');
  if (length > MAX_SUMMARY_DAYS) {
    throw new InvalidSummaryQueryError(
      `the period must not exceed ${String(MAX_SUMMARY_DAYS)} days`,
    );
  }
  return {
    from,
    to,
    previousFrom: dayOf(dayNumber(from) - length),
    previousTo: dayOf(dayNumber(from) - 1),
  };
}
