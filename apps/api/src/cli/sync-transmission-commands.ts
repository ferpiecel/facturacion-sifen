import { eq } from 'drizzle-orm';
import { tenantFiscalProfiles, withTenantTransaction, type Database } from '@sifen/db';
import { recordAudit } from '../modules/audit/infrastructure/record-audit.js';

const OPERATOR = { type: 'operator', id: 'ops-cli' } as const;

export interface SyncTransmissionResult {
  tenantId: string;
  enabled: boolean;
  /** False when the flag already had the requested value. */
  changed: boolean;
}

/**
 * Operator CLI (HU-E6-06): opts a tenant in or out of synchronous transmission (siRecepDE for a lote
 * of one DE). The worker clears the flag by itself on SIFEN code 1264; this is the only way to set it.
 */
export async function setSyncTransmission(
  db: Database,
  params: { tenantId: string; enabled: boolean },
): Promise<SyncTransmissionResult> {
  return await withTenantTransaction(db, params.tenantId, async (tx) => {
    const profile = await tx
      .select({ enabled: tenantFiscalProfiles.syncTransmission })
      .from(tenantFiscalProfiles)
      .where(eq(tenantFiscalProfiles.tenantId, params.tenantId))
      .then((rows) => rows.at(0));
    if (profile === undefined) throw new Error('the tenant has no fiscal profile');
    if (profile.enabled === params.enabled) {
      return { tenantId: params.tenantId, enabled: params.enabled, changed: false };
    }
    await tx
      .update(tenantFiscalProfiles)
      .set({ syncTransmission: params.enabled, updatedAt: new Date() })
      .where(eq(tenantFiscalProfiles.tenantId, params.tenantId));
    await recordAudit(tx, {
      actor: OPERATOR,
      action: 'tenant.sync_transmission_set',
      entity: { type: 'tenant', id: params.tenantId },
      before: { syncTransmission: profile.enabled },
      after: { syncTransmission: params.enabled },
    });
    return { tenantId: params.tenantId, enabled: params.enabled, changed: true };
  });
}
