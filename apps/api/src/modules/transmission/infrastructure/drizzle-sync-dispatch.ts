import { and, eq, inArray } from 'drizzle-orm';
import {
  documents,
  loteDocuments,
  lotes,
  tenantFiscalProfiles,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import type { SyncDispatch } from '../application/send-lote.js';
import { settleDocument } from './settle-document.js';
import { TRANSMISSION_WORKER_ACTOR } from './transmission-audit-actor.js';

export interface DrizzleSyncDispatchOptions {
  readonly db: Database;
  readonly tenantId: string;
  readonly now?: () => Date;
}

/** `SyncDispatch` over the tenant's fiscal profile and its `lotes`; every call runs inside the tenant's transaction (HU-E6-06). */
export function createDrizzleSyncDispatch({
  db,
  tenantId,
  now = () => new Date(),
}: DrizzleSyncDispatchOptions): SyncDispatch {
  return {
    async isEnabled() {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({ enabled: tenantFiscalProfiles.syncTransmission })
          .from(tenantFiscalProfiles)
          .where(eq(tenantFiscalProfiles.tenantId, tenantId)),
      );
      return rows.at(0)?.enabled === true;
    },

    async disable(reason) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        const cleared = await tx
          .update(tenantFiscalProfiles)
          .set({ syncTransmission: false, updatedAt: now() })
          .where(
            and(
              eq(tenantFiscalProfiles.tenantId, tenantId),
              eq(tenantFiscalProfiles.syncTransmission, true),
            ),
          )
          .returning({ tenantId: tenantFiscalProfiles.tenantId });
        if (cleared.length === 0) return;
        await recordAudit(tx, {
          actor: TRANSMISSION_WORKER_ACTOR,
          action: 'tenant.sync_transmission_disabled',
          entity: { type: 'tenant', id: tenantId },
          before: { syncTransmission: true },
          after: { syncTransmission: false, reason },
        });
      });
    },

    async recordSettled(loteId, resolution) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        const updated = await tx
          .update(lotes)
          .set({ status: 'sent', sentAt: now(), updatedAt: now() })
          .where(and(eq(lotes.id, loteId), eq(lotes.status, 'sending')))
          .returning({ id: lotes.id });
        if (updated.length !== 1) throw new Error(`Lote ${loteId} is not in sending state`);
        // The status guard has no `sending -> processed` edge; a synchronous answer passes through `sent` like a polled one.
        await tx
          .update(lotes)
          .set({ status: 'processed', updatedAt: now() })
          .where(eq(lotes.id, loteId));
        // Same path as a batch: queued -> submitted (with its outbox event), then the outcome.
        const submitted = await tx
          .update(documents)
          .set({ status: 'submitted', updatedAt: now() })
          .where(
            and(
              eq(documents.status, 'queued'),
              inArray(
                documents.id,
                tx
                  .select({ id: loteDocuments.documentId })
                  .from(loteDocuments)
                  .where(eq(loteDocuments.loteId, loteId)),
              ),
            ),
          )
          .returning({ id: documents.id });
        await enqueueDocumentEvents(tx, {
          tenantId,
          documentIds: submitted.map((row) => row.id),
          at: now(),
        });
        await settleDocument(tx, tenantId, loteId, resolution, now());
      });
    },
  };
}
