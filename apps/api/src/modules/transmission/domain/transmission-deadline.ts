/** SIFEN gives 72 h from signing to transmit (ADR-0008). The single source for the summary and the alerts. */
export const TRANSMISSION_WINDOW_MS = 72 * 3_600_000;

/** Hours since signing at which the tenant is warned (HU-E6-07, RNF-06). */
export const DEADLINE_WARNING_HOURS = [48, 66] as const;

export function transmissionDeadline(signedAt: Date): Date {
  return new Date(signedAt.getTime() + TRANSMISSION_WINDOW_MS);
}

/** Time left to the deadline in hours, to a tenth; zero once it has passed. */
export function hoursRemaining(deadline: Date, now: Date): number {
  return Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 360_000) / 10);
}
