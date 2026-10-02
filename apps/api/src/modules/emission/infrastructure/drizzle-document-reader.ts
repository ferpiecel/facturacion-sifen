import { and, eq } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
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
import type { SignedXmlReader } from '../application/ports/signed-xml-reader.port.js';

function select<Extra extends Record<string, PgColumn>>(tx: TenantTx, extra: Extra) {
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
        ...extra,
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
export function createDrizzleDocumentReader(db: Database): DocumentReader & SignedXmlReader {
  const row = <Extra extends Record<string, PgColumn>>(
    tenantId: string,
    condition: ReturnType<typeof eq>,
    extra: Extra,
  ) =>
    withTenantTransaction(db, tenantId, async (tx) => {
      const rows = await select(tx, extra)
        .where(and(eq(documents.tenantId, tenantId), condition))
        .limit(1);
      return rows.at(0) ?? null;
    });
  const numberOf = (r: { establishment: string; point: string; number: number | string }) =>
    `${r.establishment}-${r.point}-${String(r.number).padStart(7, '0')}`;
  const find = async (tenantId: string, condition: ReturnType<typeof eq>) => {
    const found = await row(tenantId, condition, {});
    if (!found) return null;
    // The signed XML stays inside the signed-XML port: the query side never exposes it.
    const view: DocumentView = {
      documentId: found.documentId,
      cdc: found.cdc,
      number: numberOf(found),
      status: found.status,
      environment: found.environment,
      issuedAt: found.issuedAt,
      totalAmount: found.totalAmount,
      currency: found.currency,
      receiverRuc: found.receiverRuc,
    };
    return view;
  };
  return {
    findSignedXml: async (tenantId, id) => {
      // The signed XML is selected here only: the shared query side never carries it.
      const found = await row(tenantId, eq(documents.id, id), { signedXml: documents.signedXml });
      return found
        ? { number: numberOf(found), environment: found.environment, signedXml: found.signedXml }
        : null;
    },
    findById: (tenantId, id) => find(tenantId, eq(documents.id, id)),
    findByCdc: (tenantId, cdc) => find(tenantId, eq(documents.cdc, cdc)),
  };
}
