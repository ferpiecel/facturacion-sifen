import { auditLog, type TenantTx } from '@sifen/db';
import { redact } from '../domain/redact.js';

export interface AuditEntry {
  tenantId: string;
  actor: { type: 'api_key' | 'user' | 'operator'; id: string };
  action: string;
  entity: { type: string; id: string };
  before: unknown;
  after: unknown;
}

/**
 * Appends one audit row inside the caller's tenant transaction, so the audit
 * record commits or rolls back together with the write it describes.
 * `before`/`after` are redacted here, never by the caller.
 */
export async function recordAudit(tx: TenantTx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: entry.tenantId,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    action: entry.action,
    entityType: entry.entity.type,
    entityId: entry.entity.id,
    before: redact(entry.before),
    after: redact(entry.after),
  });
}
