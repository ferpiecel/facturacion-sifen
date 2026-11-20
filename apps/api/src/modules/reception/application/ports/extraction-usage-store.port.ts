/** Per-tenant, per-day count of extractions queued (reception R5.9). */
export interface ExtractionUsageStore {
  /**
   * Atomically takes one slot of `usageDate` (UTC `YYYY-MM-DD`) while fewer than `cap` are used.
   * Returns the new count, or null when the cap was already reached. Two concurrent calls can
   * never both take the last slot.
   */
  tryConsume(tenantId: string, usageDate: string, cap: number): Promise<number | null>;
  /** Gives one slot back (never below zero). */
  release(tenantId: string, usageDate: string): Promise<void>;
}
