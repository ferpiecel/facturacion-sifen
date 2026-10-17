import { and, asc, count, desc, eq, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import {
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import type {
  AttentionQuery,
  PortalAttentionRow,
  PortalAttentionSource,
} from '../application/ports/portal-attention-source.port.js';

const PENDING = ['signed', 'queued', 'submitted'];
const NOT_YET_SENT = ['accepted', ...PENDING];
const statusIn = (statuses: string[]) =>
  sql`${documents.status} in (${sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  )})`;

const UNNAMED_RECEIVER = 'Sin Nombre';
const number = sql<string>`${tenantEstablishments.code} || '-' || ${tenantExpeditionPoints.code} || '-' || lpad(${documents.number}::text, 7, '0')`;
const receiverName = sql<string>`coalesce(${documents.payload}->'receiver'->>'name', ${UNNAMED_RECEIVER})`;

/** Rejected, held before being sent, or pending and signed early enough to be due soon or overdue. */
const needsAttention = (tenantId: string, query: AttentionQuery): SQL =>
  and(
    eq(documents.tenantId, tenantId),
    or(
      eq(documents.status, 'rejected'),
      and(isNotNull(documents.transmissionHold), statusIn(NOT_YET_SENT)),
      and(
        statusIn(PENDING),
        sql`${documents.signedAt} <= ${query.dueSoonBefore.toISOString()}::timestamptz`,
      ),
    ),
  ) as SQL;

/** Reads inside `withTenantTransaction`; the explicit tenant filter backs up RLS. */
export class SqlPortalAttentionSource implements PortalAttentionSource {
  constructor(private readonly db: Database) {}

  listNeedingAttention(tenantId: string, query: AttentionQuery) {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const base = (fields: object) =>
        tx
          .select(fields as never)
          .from(documents)
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
          .where(needsAttention(tenantId, query));
      const rows = (await base({
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
        signedAt: documents.signedAt,
        transmissionHold: documents.transmissionHold,
        sifenMessages: documents.sifenMessages,
      })
        .orderBy(asc(documents.signedAt), desc(documents.issuedAt), desc(documents.id))
        .limit(query.limit)) as unknown as PortalAttentionRow[];
      const [{ total }] = (await base({ total: count() })) as unknown as { total: number }[];
      return { rows, total };
    });
  }
}
