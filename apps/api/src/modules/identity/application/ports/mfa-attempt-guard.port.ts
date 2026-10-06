/**
 * Consecutive second-factor attempts per user, independent of the per-window throttle: only a success resets
 * the count, never the passing of time (HU-E1-07 hardening). Once the cap is reached the user cannot verify an
 * MFA code until an MFA reset (an owner/admin or the operator) removes the enrolment.
 */
export interface MfaAttemptGuard {
  /** Reserves one attempt atomically BEFORE the code is checked; false = refused (cap reached or locked). */
  reserve(userId: string): Promise<boolean>;
  /** A verified code: resets the consecutive count (a locked user stays locked). */
  succeeded(userId: string): Promise<void>;
}
