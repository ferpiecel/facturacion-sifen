import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  isNotNull,
  like,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { receivedDocuments, withTenantTransaction, type Database } from '@sifen/db';
import type {
  ReceivedDocumentListQuery,
  ReceivedDocumentQuery,
  ReceivedDocumentSummary,
} from '../../application/ports/received-document-query.port.js';
import { readDocumentDetail, toDocument } from './drizzle-received-document-repository.js';

/** Everything but `raw_data`, which can be large and never reaches a list. */
const LIST_COLUMNS = Object.fromEntries(
  Object.entries(getTableColumns(receivedDocuments)).filter(([name]) => name !== 'rawData'),
) as Omit<ReturnType<typeof getTableColumns<typeof receivedDocuments>>, 'rawData'>;

function filters(tenantId: string, query: ReceivedDocumentListQuery): SQL[] {
  const t = receivedDocuments;
  const conditions: (SQL | undefined)[] = [
    eq(t.tenantId, tenantId),
    query.status ? eq(t.status, query.status) : undefined,
    query.source ? eq(t.source, query.source) : undefined,
    query.issuerRucBase ? eq(t.issuerRucBase, query.issuerRucBase) : undefined,
    query.issuedFrom ? gte(t.issuedAt, query.issuedFrom) : undefined,
    query.issuedBefore ? lt(t.issuedAt, query.issuedBefore) : undefined,
    query.isOwnReceiver === undefined ? undefined : eq(t.isOwnReceiver, query.isOwnReceiver),
    // Digits only (validated upstream), so no LIKE wildcard can appear.
    query.cdcPrefix ? and(isNotNull(t.cdc), like(t.cdc, `${query.cdcPrefix}%`)) : undefined,
    query.updatedSince ? gte(t.updatedAt, query.updatedSince) : undefined,
    query.after
      ? // Row comparison on the exact stored timestamp text: a JS Date would drop microseconds
        // and skip rows that share a millisecond.
        or(
          lt(t.createdAt, sql`${query.after.createdAt}::timestamptz`),
          and(
            eq(t.createdAt, sql`${query.after.createdAt}::timestamptz`),
            lt(t.id, sql`${query.after.id}::uuid`),
          ),
        )
      : undefined,
  ];
  return conditions.filter((condition): condition is SQL => condition !== undefined);
}

/** `ReceivedDocumentQuery` over the `received_*` tables, each call in its own tenant transaction. */
export function createDrizzleReceivedDocumentQuery(db: Database): ReceivedDocumentQuery {
  return {
    list(tenantId, query) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const rows = await tx
          .select({
            ...LIST_COLUMNS,
            createdAtKey: sql<string>`${receivedDocuments.createdAt}::text`,
          })
          .from(receivedDocuments)
          .where(and(...filters(tenantId, query)))
          .orderBy(desc(receivedDocuments.createdAt), desc(receivedDocuments.id))
          .limit(query.limit + 1);
        return rows.map((row): ReceivedDocumentSummary => ({
          document: toDocument(row),
          header: {
            documentType: row.documentType,
            cdc: row.cdc,
            establishmentCode: row.establishmentCode,
            expeditionPointCode: row.expeditionPointCode,
            documentNumber: row.documentNumber,
            issuerRucBase: row.issuerRucBase,
            issuerRucDv: row.issuerRucDv,
            issuerLegalName: row.issuerLegalName,
            issuedAt: row.issuedAt,
            currency: row.currency,
            totalVat: row.totalVat,
            totalAmount: row.totalAmount,
            confirmedBy: row.confirmedBy,
          },
          hasArtifact: row.artifactId !== null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          createdAtKey: row.createdAtKey,
        }));
      });
    },

    find(tenantId, id) {
      return withTenantTransaction(db, tenantId, (tx) => readDocumentDetail(tx, tenantId, id));
    },
  };
}
