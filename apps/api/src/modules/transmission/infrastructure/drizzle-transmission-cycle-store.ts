import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import {
  documents,
  loteDocuments,
  lotes,
  nextRequestId,
  tenantFiscalProfiles,
  tenants,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import type { PendingLote, TransmissionCycleStore } from '../application/transmission-cycle.js';

export interface DrizzleTransmissionCycleStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

/** `TransmissionCycleStore` over `documents`, `lotes` and the dId sequence, run as app_user inside the tenant's transaction. */
export function createDrizzleTransmissionCycleStore({
  db,
  tenantId,
}: DrizzleTransmissionCycleStoreOptions): TransmissionCycleStore {
  return {
    async acceptedDocumentIds(limit) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({ id: documents.id })
          .from(documents)
          // Only the tenant's current environment, like the assembler: an old one must not starve the batch.
          .innerJoin(
            tenants,
            and(eq(tenants.id, documents.tenantId), eq(tenants.environment, documents.environment)),
          )
          .where(and(eq(documents.tenantId, tenantId), eq(documents.status, 'accepted')))
          .orderBy(asc(documents.createdAt), asc(documents.id))
          .limit(limit),
      );
      return rows.map((row) => row.id);
    },

    async pendingLotes(limit) {
      return withTenantTransaction(db, tenantId, async (tx): Promise<PendingLote[]> => {
        const pending = await tx
          .select({ id: lotes.id, documentType: lotes.documentType })
          .from(lotes)
          // Only the tenant's current environment: a lote of a left one must not be sent.
          .innerJoin(
            tenants,
            and(eq(tenants.id, lotes.tenantId), eq(tenants.environment, lotes.environment)),
          )
          .where(and(eq(lotes.tenantId, tenantId), eq(lotes.status, 'pending')))
          .orderBy(asc(lotes.createdAt), asc(lotes.id))
          .limit(limit);
        if (pending.length === 0) return [];

        const profile = await tx
          .select({ rucBase: tenantFiscalProfiles.rucBase, rucDv: tenantFiscalProfiles.rucDv })
          .from(tenantFiscalProfiles)
          .where(eq(tenantFiscalProfiles.tenantId, tenantId))
          .then((found) => found.at(0));
        if (!profile) throw new Error('The tenant has no fiscal profile');

        const rows = await tx
          .select({ loteId: loteDocuments.loteId, cdc: documents.cdc, xml: documents.signedXml })
          .from(loteDocuments)
          .innerJoin(
            documents,
            and(
              eq(documents.tenantId, loteDocuments.tenantId),
              eq(documents.id, loteDocuments.documentId),
            ),
          )
          .where(
            inArray(
              loteDocuments.loteId,
              pending.map((lote) => lote.id),
            ),
          )
          .orderBy(asc(documents.createdAt), asc(documents.id));

        // A lote with an unsigned document is skipped, never sent short: it is picked up again once complete.
        return pending.flatMap((lote) => {
          const members = rows.filter((row) => row.loteId === lote.id);
          const signed = members.flatMap((row) =>
            row.xml === null ? [] : [{ cdc: row.cdc, xml: row.xml }],
          );
          if (signed.length === 0 || signed.length < members.length) return [];
          return [
            {
              loteId: lote.id,
              lote: {
                ...profile,
                documentType: String(lote.documentType).padStart(2, '0'),
                documents: signed,
              },
            },
          ];
        });
      });
    },

    async dueLoteIds(now, limit) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({ id: lotes.id })
          .from(lotes)
          .innerJoin(
            tenants,
            and(eq(tenants.id, lotes.tenantId), eq(tenants.environment, lotes.environment)),
          )
          .where(
            and(eq(lotes.tenantId, tenantId), eq(lotes.status, 'sent'), lte(lotes.nextPollAt, now)),
          )
          .orderBy(asc(lotes.nextPollAt), asc(lotes.id))
          .limit(limit),
      );
      return rows.map((row) => row.id);
    },

    nextRequestId() {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const tenant = await tx
          .select({ environment: tenants.environment })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .then((found) => found.at(0));
        if (!tenant) throw new Error('Tenant not found');
        return nextRequestId(tx, tenantId, tenant.environment);
      });
    },
  };
}
