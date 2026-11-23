/** Counts of paid eKuatia solves, per tenant and platform-wide, per UTC day (reception R6.3). */
export type SolveReservation =
  | { readonly ok: true }
  /** `scope` says which cap was reached; nothing was taken in either counter. */
  | { readonly ok: false; readonly scope: 'tenant' | 'global' };

export interface SolveUsageStore {
  /**
   * Atomically takes one slot of `usageDate` (UTC `YYYY-MM-DD`) in the tenant counter and in the
   * global counter, unless either already reached its cap. All or nothing: a refusal leaves both
   * counters unchanged, and two concurrent calls can never both take the last slot.
   */
  tryConsume(
    tenantId: string,
    usageDate: string,
    caps: { readonly tenant: number; readonly global: number },
  ): Promise<SolveReservation>;
  /** Gives one slot back in both counters (never below zero). */
  release(tenantId: string, usageDate: string): Promise<void>;
}
