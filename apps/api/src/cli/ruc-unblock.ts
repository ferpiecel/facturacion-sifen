import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { assertValidTenantId, rucBlocks, tenants, type Database } from '@sifen/db';
import { asPlatformAdmin } from './platform-admin.js';
import { recordAudit } from '../modules/audit/infrastructure/record-audit.js';

const MAX_REASON_LENGTH = 500;
const MAX_ACTOR_LENGTH = 255;

export interface RucUnblockResult {
  tenantId: string;
  /** Pauses lifted (one tenant can hold several overlapping ones). */
  lifted: number;
  /** When the longest lifted pause would have ended. */
  previousUntil: Date;
}

/**
 * Operator CLI (HU-E6-05, HU-E14): lifts the tenant's active RUC pause early, so the next transmission
 * cycle sends again. Active means inside its window, not already lifted and earned in the tenant's
 * current environment (the same rule as the cycle's guard). The rows are never deleted: they get
 * `lifted_at/by/reason`, so the history stays. Runs as `platform_admin` through `asPlatformAdmin`, so the use is recorded in `platform_audit_log` (the only role with UPDATE on
 * those columns) with the tenant bound, and audits `ruc_block.lifted` with the operator and the reason.
 * Refuses, writing nothing, when there is no active pause.
 */
export async function unblockRuc(
  db: Database,
  params: { tenantId: string; actor: string; reason: string },
  now: Date,
): Promise<RucUnblockResult> {
  assertValidTenantId(params.tenantId);
  const actor = params.actor.trim();
  const reason = params.reason.trim();
  if (actor === '' || actor.length > MAX_ACTOR_LENGTH) {
    throw new Error(`actor must be 1 to ${String(MAX_ACTOR_LENGTH)} characters`);
  }
  if (reason === '' || reason.length > MAX_REASON_LENGTH) {
    throw new Error(`reason must be 1 to ${String(MAX_REASON_LENGTH)} characters`);
  }
  const use = { purpose: 'ruc:unblock', scope: ['ruc_blocks', 'tenants'] };
  return await asPlatformAdmin(db, use, async (tx) => {
    // The audit row takes its tenant from this setting, like in withTenantTransaction.
    await tx.execute(sql`select set_config('app.current_tenant', ${params.tenantId}, true)`);
    const active = await tx
      .select({ id: rucBlocks.id, blockedUntil: rucBlocks.blockedUntil })
      .from(rucBlocks)
      .innerJoin(
        tenants,
        and(eq(tenants.id, rucBlocks.tenantId), eq(tenants.environment, rucBlocks.environment)),
      )
      .where(
        and(
          eq(rucBlocks.tenantId, params.tenantId),
          gt(rucBlocks.blockedUntil, now),
          isNull(rucBlocks.liftedAt),
        ),
      )
      .for('update', { of: rucBlocks });
    if (active.length === 0) throw new Error('no active RUC block for the tenant');
    const previousUntil = new Date(Math.max(...active.map((row) => row.blockedUntil.getTime())));
    for (const row of active) {
      await tx
        .update(rucBlocks)
        .set({ liftedAt: now, liftedBy: actor, liftReason: reason })
        .where(and(eq(rucBlocks.id, row.id), isNull(rucBlocks.liftedAt)));
    }
    await recordAudit(tx, {
      actor: { type: 'operator', id: actor },
      action: 'ruc_block.lifted',
      entity: { type: 'tenant', id: params.tenantId },
      before: { blockedUntil: previousUntil.toISOString(), blocks: active.length },
      after: { liftedAt: now.toISOString(), reason },
    });
    return { tenantId: params.tenantId, lifted: active.length, previousUntil };
  });
}
