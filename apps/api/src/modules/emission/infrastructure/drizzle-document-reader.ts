import { and, eq } from 'drizzle-orm';
import {
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import type { DocumentReader, DocumentView } from '../application/ports/document-reader.port.js';

function select(tx: TenantTx) {
  return (
    tx
      .select({
        documentId: documents.id,
        cdc: documents.cdc,
        establishment: tenantEstablishments.code,
        point: tenantExpeditionPoints.code,
        number: documents.number,
        status: documents.status,
        environment: documents.environment,
        issuedAt: documents.issuedAt,
        totalAmount: documents.totalAmount,
        currency: documents.currency,
        receiverRuc: documents.receiverRuc,
      })
      .from(documents)
      // The CDC key is (tenant, environment, cdc): only the tenant's current environment is visible.
      .innerJoin(
        tenants,
        and(eq(tenants.id, documents.tenantId), eq(tenants.environment, documents.environment)),
      )
      .innerJoin(
        tenantExpeditionPoints,
        and(
          eq(tenantExpeditionPoints.tenantId, documents.tenantId),
          eq(tenantExpeditionPoints.id, documents.expeditionPointId),
        ),
      )
      .innerJoin(
        tenantEstablishments,
        and(
          eq(tenantEstablishments.tenantId, documents.tenantId),
          eq(tenantEstablishments.id, documents.establishmentId),
        ),
      )
  );
}

/** Reads inside `withTenantTransaction`; the explicit tenant filter backs up RLS. */
export function createDrizzleDocumentReader(db: Database): DocumentReader {
  const find = (tenantId: string, condition: ReturnType<typeof eq>) =>
    withTenantTransaction(db, tenantId, async (tx) => {
      const rows = await select(tx)
        .where(and(eq(documents.tenantId, tenantId), condition))
        .limit(1);
      const row = rows.at(0);
      if (!row) return null;
      const { establishment, point, number, ...rest } = row;
      const view: DocumentView = {
        ...rest,
        number: `${establishment}-${point}-${String(number).padStart(7, '0')}`,
      };
      return view;
    });
  return {
    findById: (tenantId, id) => find(tenantId, eq(documents.id, id)),
    findByCdc: (tenantId, cdc) => find(tenantId, eq(documents.cdc, cdc)),
  };
}
