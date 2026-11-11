import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { documents, tenants, withTenantTransaction, type Database } from '@sifen/db';
import { enqueueDeadlineWarnings } from '../../webhooks/infrastructure/enqueue-deadline-warnings.js';
import type { DeadlineWarningStore } from '../application/ports/deadline-warning-store.port.js';

/** Same set the portal summary counts as pending: signed, not yet settled by SIFEN. */
const PENDING_STATUSES = ['signed', 'queued', 'submitted'];

export interface DrizzleDeadlineWarningStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

/** `DeadlineWarningStore` over `documents` and the webhook outbox, as app_user in the tenant's transaction. */
export function createDrizzleDeadlineWarningStore({
  db,
  tenantId,
}: DrizzleDeadlineWarningStoreOptions): DeadlineWarningStore {
  return {
    findPending({ after, until }) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ id: documents.id, cdc: documents.cdc, signedAt: documents.signedAt })
          .from(documents)
          .innerJoin(
            tenants,
            and(eq(tenants.id, documents.tenantId), eq(tenants.environment, documents.environment)),
          )
          .where(
            and(
              eq(documents.tenantId, tenantId),
              inArray(documents.status, PENDING_STATUSES),
              gt(documents.signedAt, after),
              lte(documents.signedAt, until),
            ),
          );
        return rows.flatMap((row) => (row.signedAt ? [{ ...row, signedAt: row.signedAt }] : []));
      });
    },
    enqueue(warnings, at) {
      return withTenantTransaction(db, tenantId, (tx) =>
        enqueueDeadlineWarnings(tx, { tenantId, warnings, at }),
      );
    },
  };
}
