import { and, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import {
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import type {
  PortalDocumentRow,
  PortalDocumentSource,
} from '../application/ports/portal-document-source.port.js';
import type { DocumentListFilter } from '../domain/list-query.js';

/** The receiver of an unnamed (innominado) DE carries no name in the payload; NT 024 fixes the text. */
const UNNAMED_RECEIVER = 'Sin Nombre';
const PARAGUAY_TIME_ZONE = 'America/Asuncion';

const number = sql<string>`${tenantEstablishments.code} || '-' || ${tenantExpeditionPoints.code} || '-' || lpad(${documents.number}::text, 7, '0')`;
const receiverName = sql<string>`coalesce(${documents.payload}->'receiver'->>'name', ${UNNAMED_RECEIVER})`;
const issuedDay = sql`(${documents.issuedAt} at time zone ${PARAGUAY_TIME_ZONE})::date`;

/** `%`, `_` and `\` in the user's text are literals, not wildcards. */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

function conditions(tenantId: string, filter: DocumentListFilter): SQL {
  const parts: (SQL | undefined)[] = [
    eq(documents.tenantId, tenantId),
    filter.documentType === undefined ? undefined : eq(documents.documentType, filter.documentType),
    filter.status === undefined ? undefined : eq(documents.status, filter.status),
    filter.from === undefined ? undefined : sql`${issuedDay} >= ${filter.from}::date`,
    filter.to === undefined ? undefined : sql`${issuedDay} <= ${filter.to}::date`,
  ];
  if (filter.q !== undefined) {
    const pattern = contains(filter.q);
    parts.push(
      or(
        ilike(documents.cdc, pattern),
        ilike(documents.receiverRuc, pattern),
        ilike(number, pattern),
        ilike(receiverName, pattern),
      ),
    );
  }
  return and(...parts) as SQL;
}

// Same visibility as the API: only the tenant's current environment, with the document's point and establishment.
const onTenant = and(
  eq(tenants.id, documents.tenantId),
  eq(tenants.environment, documents.environment),
);
const onPoint = and(
  eq(tenantExpeditionPoints.tenantId, documents.tenantId),
  eq(tenantExpeditionPoints.id, documents.expeditionPointId),
);
const onEstablishment = and(
  eq(tenantEstablishments.tenantId, documents.tenantId),
  eq(tenantEstablishments.id, documents.establishmentId),
);

const rowFields = {
  id: documents.id,
  cdc: documents.cdc,
  documentType: documents.documentType,
  number,
  issuedAt: documents.issuedAt,
  receiverName,
  receiverRuc: documents.receiverRuc,
  totalAmount: documents.totalAmount,
  currency: documents.currency,
  status: documents.status,
};

/** Reads inside `withTenantTransaction`; the explicit tenant filter backs up RLS. */
export class SqlPortalDocumentSource implements PortalDocumentSource {
  constructor(private readonly db: Database) {}

  list(tenantId: string, filter: DocumentListFilter) {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const where = conditions(tenantId, filter);
      const rows: PortalDocumentRow[] = await tx
        .select(rowFields)
        .from(documents)
        .innerJoin(tenants, onTenant)
        .innerJoin(tenantExpeditionPoints, onPoint)
        .innerJoin(tenantEstablishments, onEstablishment)
        .where(where)
        .orderBy(desc(documents.issuedAt), desc(documents.id))
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize);
      const [{ total }] = await tx
        .select({ total: count() })
        .from(documents)
        .innerJoin(tenants, onTenant)
        .innerJoin(tenantExpeditionPoints, onPoint)
        .innerJoin(tenantEstablishments, onEstablishment)
        .where(where);
      return { rows, total };
    });
  }

  findById(tenantId: string, id: string) {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          ...rowFields,
          environment: documents.environment,
          createdAt: documents.createdAt,
          signedAt: documents.signedAt,
          updatedAt: documents.updatedAt,
          sifenMessages: documents.sifenMessages,
        })
        .from(documents)
        .innerJoin(tenants, onTenant)
        .innerJoin(tenantExpeditionPoints, onPoint)
        .innerJoin(tenantEstablishments, onEstablishment)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.id, id)))
        .limit(1);
      return rows.at(0) ?? null;
    });
  }
}
