/** The job carries the tenant and the CDC to look up; the document does not exist yet. */
export interface EkuatiaLookupJob {
  readonly tenantId: string;
  /** Validated 44-digit CDC (check digit already verified). */
  readonly cdc: string;
  /** UTC day (`YYYY-MM-DD`) of the solve slot reserved for this job, so the worker can give it back. */
  readonly usageDate: string;
}

export interface EkuatiaLookupQueue {
  /**
   * Schedules the lookup. Idempotent per (tenant, CDC) while a job for it is waiting or running:
   * a second call is a no-op and `enqueued` is false, so the caller can give its solve slot back.
   *
   * @throws ReceptionQueueUnavailableError when the job was definitely not enqueued.
   * @throws ReceptionQueueOutcomeUnknownError (a subclass) when it may have been: the caller must
   *   keep the solve slot.
   */
  enqueueLookup(job: EkuatiaLookupJob): Promise<{ readonly enqueued: boolean }>;
}
