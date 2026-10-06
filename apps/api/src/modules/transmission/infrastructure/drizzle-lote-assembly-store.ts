import { and, asc, eq, inArray, isNotNull, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import {
  documents,
  loteDocuments,
  lotes,
  tenants,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import type { LoteAssemblyStore } from '../application/assemble-lotes.js';

export interface DrizzleLoteAssemblyStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  /** Most documents read per assembly run; the rest wait for the next one. */
  readonly batchSize?: number;
  readonly now?: () => Date;
}

const DEFAULT_BATCH_SIZE = 500;
const READY_STATUSES = ['signed', 'queued'];
/** SIFEN may hold the CDCs of these lotes (ADR-0007, plan 8.1); `rejected` and `processed` are finished. */
export const IN_PROCESS_LOTE_STATUSES = ['pending', 'sending', 'sent', 'unknown', 'recovery'];

/**
 * A lote in process only carries a document that was not queued again after the lote existed: the
 * recovery's resend (`resent_at`) leaves the older lote behind (it may stay `recovery` for its other
 * documents) and only a newer lote carries the document from then on.
 */
const stillCarries = sql`NOT (${documents.resentAt} IS NOT NULL AND ${documents.resentAt} > ${lotes.createdAt})`;

/** `LoteAssemblyStore` over `documents`, `lotes` and `lote_documents`, run as app_user inside the tenant's transaction. */
export function createDrizzleLoteAssemblyStore({
  db,
  tenantId,
  batchSize = DEFAULT_BATCH_SIZE,
  now = () => new Date(),
}: DrizzleLoteAssemblyStoreOptions): LoteAssemblyStore {
  return {
    async readyDocuments() {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({
            documentId: documents.id,
            cdc: documents.cdc,
            xml: documents.signedXml,
            resentAt: documents.resentAt,
          })
          .from(documents)
          // Only the tenant's current environment: documents of a previous one must never be picked
          // (nor starve the batch).
          .innerJoin(
            tenants,
            and(eq(tenants.id, documents.tenantId), eq(tenants.environment, documents.environment)),
          )
          .where(
            and(
              inArray(documents.status, READY_STATUSES),
              isNotNull(documents.signedXml),
              // Held for an operator, or backing off after a 0301 (S5f).
              isNull(documents.transmissionHold),
              or(isNull(documents.nextTransmissionAt), lte(documents.nextTransmissionAt, now())),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(loteDocuments)
                  .innerJoin(
                    lotes,
                    and(
                      eq(lotes.tenantId, loteDocuments.tenantId),
                      eq(lotes.id, loteDocuments.loteId),
                    ),
                  )
                  .where(
                    and(
                      eq(loteDocuments.documentId, documents.id),
                      inArray(lotes.status, IN_PROCESS_LOTE_STATUSES),
                      stillCarries,
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(documents.createdAt), asc(documents.id))
          .limit(batchSize),
      );
      return rows.map(({ resentAt, ...row }) => ({
        ...row,
        xml: row.xml ?? '',
        resent: resentAt !== null,
        ...(resentAt ? { resentAt } : {}),
      }));
    },

    async deferDocument(documentId, until) {
      await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(documents)
          .set({ nextTransmissionAt: until, updatedAt: now() })
          .where(waitingToBeResent(tenantId, documentId)),
      );
    },

    async holdResend(documentId, reason) {
      await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(documents)
          .set({ transmissionHold: reason, updatedAt: now() })
          .where(waitingToBeResent(tenantId, documentId)),
      );
    },

    async cdcsInProcess(cdcs) {
      if (cdcs.length === 0) return new Set<string>();
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .selectDistinct({ cdc: documents.cdc })
          .from(documents)
          .innerJoin(
            loteDocuments,
            and(
              eq(loteDocuments.tenantId, documents.tenantId),
              eq(loteDocuments.documentId, documents.id),
            ),
          )
          .innerJoin(
            lotes,
            and(eq(lotes.tenantId, loteDocuments.tenantId), eq(lotes.id, loteDocuments.loteId)),
          )
          .where(
            and(
              inArray(documents.cdc, cdcs),
              inArray(lotes.status, IN_PROCESS_LOTE_STATUSES),
              stillCarries,
            ),
          ),
      );
      return new Set(rows.map((row) => row.cdc));
    },

    async createLote({ documentType, documentIds: requested }) {
      const documentIds = [...new Set(requested)];
      if (documentIds.length === 0) throw new Error('A lote needs at least one document');
      return withTenantTransaction(db, tenantId, async (tx) => {
        // Row locks serialize concurrent assemblers: the loser re-reads after the winner commits.
        const locked = await tx
          .select({
            id: documents.id,
            environment: documents.environment,
            status: documents.status,
          })
          .from(documents)
          .innerJoin(
            tenants,
            and(eq(tenants.id, documents.tenantId), eq(tenants.environment, documents.environment)),
          )
          .where(
            and(
              inArray(documents.id, documentIds),
              eq(documents.documentType, documentType),
              inArray(documents.status, READY_STATUSES),
              isNotNull(documents.signedXml),
              isNull(documents.transmissionHold),
            ),
          )
          // Same lock order for every assembler, so two of them cannot deadlock.
          .orderBy(asc(documents.id))
          .for('update', { of: documents });
        if (locked.length !== documentIds.length) return null;

        const taken = await tx
          .select({ id: loteDocuments.documentId })
          .from(loteDocuments)
          .innerJoin(
            lotes,
            and(eq(lotes.tenantId, loteDocuments.tenantId), eq(lotes.id, loteDocuments.loteId)),
          )
          .innerJoin(
            documents,
            and(
              eq(documents.tenantId, loteDocuments.tenantId),
              eq(documents.id, loteDocuments.documentId),
            ),
          )
          .where(
            and(
              inArray(loteDocuments.documentId, documentIds),
              inArray(lotes.status, IN_PROCESS_LOTE_STATUSES),
              stillCarries,
            ),
          )
          .limit(1);
        if (taken.length > 0) return null;

        const environments = new Set(locked.map((row) => row.environment));
        const [environment] = [...environments];
        if (environments.size !== 1) {
          throw new Error('A lote cannot mix documents of different environments');
        }

        const [lote] = await tx
          .insert(lotes)
          .values({ tenantId, environment, documentType })
          .returning({ id: lotes.id });
        await tx
          .insert(loteDocuments)
          .values(documentIds.map((documentId) => ({ tenantId, loteId: lote.id, documentId })));
        await tx
          .update(documents)
          .set({ status: 'queued', updatedAt: now() })
          .where(and(inArray(documents.id, documentIds), eq(documents.status, 'signed')));
        return lote.id;
      });
    },
  };
}

/** A queued, resent, unheld document of the tenant: the only kind the pre-send check may postpone or hold. */
function waitingToBeResent(tenantId: string, documentId: string) {
  return and(
    eq(documents.tenantId, tenantId),
    eq(documents.id, documentId),
    eq(documents.status, 'queued'),
    isNotNull(documents.resentAt),
    isNull(documents.transmissionHold),
  );
}
