import { sql } from 'drizzle-orm';
import { auditLog, isValidTenantId, type TenantTx } from '@sifen/db';
import type { AuditEntry, RecordAudit } from '../application/ports/record-audit.port.js';
import { redact } from '../domain/redact.js';

export class MissingTenantContextError extends Error {
  constructor() {
    super('recordAudit requires a tenant transaction context (withTenantTransaction)');
    this.name = 'MissingTenantContextError';
  }
}

/** Reads the tenant `withTenantTransaction` bound to this transaction. */
async function currentTenantId(tx: TenantTx): Promise<string> {
  const result = (await tx.execute(
    sql`select nullif(current_setting('app.current_tenant', true), '') as "tenantId"`,
  )) as { rows: { tenantId: string | null }[] };
  const tenantId = result.rows[0]?.tenantId;
  if (!tenantId || !isValidTenantId(tenantId)) {
    throw new MissingTenantContextError();
  }
  return tenantId;
}

/** `before`/`after` are redacted here, never by the caller. */
export const recordAudit: RecordAudit<TenantTx> = async (tx, entry: AuditEntry) => {
  const tenantId = await currentTenantId(tx);
  await tx.insert(auditLog).values({
    tenantId,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    action: entry.action,
    entityType: entry.entity.type,
    entityId: entry.entity.id,
    before: redact(entry.before),
    after: redact(entry.after),
  });
};
