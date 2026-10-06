/**
 * Consecutive second-factor attempts of the user behind ONE pending session, independent of the per-window
 * throttle: only a success resets the count, never the passing of time (HU-E1-07 hardening). An implementation
 * is bound to that pending session and takes no user id, so it cannot be pointed at another user. Once the cap is
 * reached the user cannot verify an MFA code until an MFA reset (an owner/admin or the operator) removes the
 * enrolment.
 */
export interface MfaAttemptGuard {
  /** Reserves one attempt atomically BEFORE the code is checked; false = refused (cap reached, locked, or no live pending session). */
  reserve(): Promise<boolean>;
  /** A verified code: resets the consecutive count (a locked user stays locked). */
  succeeded(): Promise<void>;
}
