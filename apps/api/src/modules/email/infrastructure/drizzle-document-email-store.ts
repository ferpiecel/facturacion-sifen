import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { documentEmails, tenants, withTenantTransaction, type Database } from '@sifen/db';
import type { DocumentEmailStore } from '../application/ports/document-email-store.port.js';

export interface DrizzleDocumentEmailStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

const OPEN = ['pending', 'failed'];

/** `DocumentEmailStore` over `document_emails`; every call runs as app_user in the tenant's transaction. */
export function createDrizzleDocumentEmailStore({
  db,
  tenantId,
}: DrizzleDocumentEmailStoreOptions): DocumentEmailStore {
  return {
    claimDue(now, limit, leaseMs) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ email: documentEmails, tenantName: tenants.name })
          .from(documentEmails)
          .innerJoin(tenants, eq(tenants.id, documentEmails.tenantId))
          .where(and(inArray(documentEmails.status, OPEN), lte(documentEmails.nextAttemptAt, now)))
          .orderBy(asc(documentEmails.nextAttemptAt), asc(documentEmails.id))
          .limit(limit)
          .for('update', { of: documentEmails, skipLocked: true });
        if (rows.length > 0) {
          await tx
            .update(documentEmails)
            .set({ nextAttemptAt: new Date(now.getTime() + leaseMs) })
            .where(
              inArray(
                documentEmails.id,
                rows.map(({ email }) => email.id),
              ),
            );
        }
        return rows.flatMap(({ email, tenantName }) =>
          email.recipient === null
            ? []
            : [
                {
                  id: email.id,
                  tenantId: email.tenantId,
                  documentId: email.documentId,
                  recipient: email.recipient,
                  attemptCount: email.attemptCount,
                  tenantName,
                },
              ],
        );
      });
    },

    async record(id, outcome) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        const updated = await tx
          .update(documentEmails)
          .set({ ...outcome, updatedAt: outcome.lastAttemptAt })
          .where(
            and(
              eq(documentEmails.id, id),
              inArray(documentEmails.status, OPEN),
              // The outcome must be the attempt right after the claimed one: a worker whose lease
              // expired cannot overwrite a newer outcome.
              eq(documentEmails.attemptCount, outcome.attemptCount - 1),
            ),
          )
          .returning({ id: documentEmails.id });
        if (updated.length !== 1) {
          throw new Error(
            `Document email ${id} is not due at attempt ${String(outcome.attemptCount - 1)}`,
          );
        }
      });
    },
  };
}
