import { sql } from 'drizzle-orm';
import { tenantRequestSequences, type tenantEnvironment } from './schema.js';
import type { TenantTx } from './tenant-transaction.js';

/** Sequence already issued 999999999999999 (the SIFEN `dId` maximum, 15 digits). */
export class RequestIdExhaustedError extends Error {
  constructor() {
    super('dId exhausted: the sequence already issued 999999999999999');
    this.name = 'RequestIdExhaustedError';
  }
}

export const MAX_REQUEST_ID = 999_999_999_999_999n;

/**
 * Atomically assigns the next `dId` (1..15 digits) for a tenant and
 * environment. Same locking and gapless-on-rollback semantics as
 * `nextDocumentNumber`: run it inside the caller's tenant transaction and keep
 * that transaction short.
 *
 * @throws RequestIdExhaustedError when the sequence already issued the maximum.
 */
export async function nextRequestId(
  tx: TenantTx,
  tenantId: string,
  environment: (typeof tenantEnvironment.enumValues)[number],
): Promise<bigint> {
  const rows = await tx
    .insert(tenantRequestSequences)
    .values({ tenantId, environment, lastValue: 1n })
    .onConflictDoUpdate({
      target: [tenantRequestSequences.tenantId, tenantRequestSequences.environment],
      set: { lastValue: sql`${tenantRequestSequences.lastValue} + 1` },
      setWhere: sql`${tenantRequestSequences.lastValue} < ${MAX_REQUEST_ID}`,
    })
    .returning({ lastValue: tenantRequestSequences.lastValue });

  if (rows.length === 0) {
    throw new RequestIdExhaustedError();
  }
  return rows[0].lastValue;
}
