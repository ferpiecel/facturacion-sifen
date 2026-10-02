import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
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
const IN_PROCESS_LOTE_STATUSES = ['pending', 'sending', 'sent', 'unknown', 'recovery'];

/** `LoteAssemblyStore` over `documents`, `lotes` and `lote_documents`, run as app_user inside the tenant's transaction. */
export function createDrizzleLoteAssemblyStore({
  db,
  tenantId,
  batchSize = DEFAULT_BATCH_SIZE,
}: DrizzleLoteAssemblyStoreOptions): LoteAssemblyStore {
  return {
    async readyDocuments() {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({ documentId: documents.id, cdc: documents.cdc, xml: documents.signedXml })
          .from(documents)
          .where(and(inArray(documents.status, READY_STATUSES), isNotNull(documents.signedXml)))
          .orderBy(asc(documents.createdAt), asc(documents.id))
          .limit(batchSize),
      );
      return rows.map((row) => ({ ...row, xml: row.xml ?? '' }));
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
            and(inArray(documents.cdc, cdcs), inArray(lotes.status, IN_PROCESS_LOTE_STATUSES)),
          ),
      );
      return new Set(rows.map((row) => row.cdc));
    },

    async createLote({ documentType, documentIds }) {
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
          .where(
            and(
              inArray(documents.id, documentIds),
              inArray(documents.status, READY_STATUSES),
              isNotNull(documents.signedXml),
            ),
          )
          .for('update');
        if (locked.length !== documentIds.length) return null;

        const taken = await tx
          .select({ id: loteDocuments.documentId })
          .from(loteDocuments)
          .innerJoin(
            lotes,
            and(eq(lotes.tenantId, loteDocuments.tenantId), eq(lotes.id, loteDocuments.loteId)),
          )
          .where(
            and(
              inArray(loteDocuments.documentId, documentIds),
              inArray(lotes.status, IN_PROCESS_LOTE_STATUSES),
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
          .set({ status: 'queued' })
          .where(and(inArray(documents.id, documentIds), eq(documents.status, 'signed')));
        return lote.id;
      });
    },
  };
}
