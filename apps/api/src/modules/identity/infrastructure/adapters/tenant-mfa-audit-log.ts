import { withTenantTransaction, type Database } from '@sifen/db';
import { recordAudit } from '../../../audit/infrastructure/record-audit.js';
import type { MfaAuditEvent, MfaAuditLog } from '../../application/ports/mfa.ports.js';

/**
 * `MfaAuditLog` over `audit_log`, which is per tenant: the event is written once in each listed tenant, inside
 * that tenant's transaction (RLS applies), as the `user` or `operator` actor. Never carries a code or a secret.
 */
export class TenantMfaAuditLog implements MfaAuditLog {
  constructor(private readonly db: Database) {}

  async record(event: MfaAuditEvent): Promise<void> {
    for (const tenantId of event.tenantIds) {
      await withTenantTransaction(this.db, tenantId, (tx) =>
        recordAudit(tx, {
          actor: event.actor,
          action: event.action,
          entity: { type: 'user', id: event.targetUserId },
          before: null,
          after: null,
        }),
      );
    }
  }
}
