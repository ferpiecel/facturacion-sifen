import { sql } from 'drizzle-orm';
import { usageCounters, type TenantTx } from '@sifen/db';
import { billingPeriod } from '../domain/billing-period.js';

export interface RecordDocumentIssuedInput {
  readonly tenantId: string;
  /** Acceptance time; picks the billing month. */
  readonly at: Date;
}

/**
 * HU-E15-02: counts one accepted document for the tenant's billing month. A single atomic
 * `INSERT ... ON CONFLICT DO UPDATE` inside the caller's tenant transaction, so the count commits or
 * rolls back with the document and no per-request aggregate query is needed.
 */
export async function recordDocumentIssued(
  tx: TenantTx,
  { tenantId, at }: RecordDocumentIssuedInput,
): Promise<void> {
  await tx
    .insert(usageCounters)
    .values({ tenantId, period: billingPeriod(at), documentsIssued: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.tenantId, usageCounters.period],
      set: { documentsIssued: sql`${usageCounters.documentsIssued} + 1` },
    });
}
