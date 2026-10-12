import { and, count, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { documents, tenants, withTenantTransaction, type Database } from '@sifen/db';
import type {
  PortalSummaryAggregates,
  PortalSummarySource,
  SummaryQuery,
} from '../application/ports/portal-summary-source.port.js';

const PARAGUAY_TIME_ZONE = 'America/Asuncion';
const TOP_CODES = 5;
const PENDING_STATUSES = ['signed', 'queued', 'submitted'];

// Same visibility as the list: only the tenant's current environment.
const onTenant = and(
  eq(tenants.id, documents.tenantId),
  eq(tenants.environment, documents.environment),
);

/** The instant an Asuncion calendar day starts; comparing `issued_at` to it can use an index. */
const dayStart = (day: string, plusDays = 0) =>
  sql`((${day}::date + ${plusDays}::int)::timestamp at time zone ${PARAGUAY_TIME_ZONE})`;

function issuedBetween(tenantId: string, from: string, to: string): SQL {
  return and(
    eq(documents.tenantId, tenantId),
    gte(documents.issuedAt, dayStart(from) as unknown as Date),
    lt(documents.issuedAt, dayStart(to, 1) as unknown as Date),
  ) as SQL;
}

const rows = sql<number>`count(*)::int`;
const amountPyg = sql<string>`coalesce(sum(${documents.totalAmount}) filter (where ${documents.currency} = 'PYG'), 0)::text`;

/** Aggregate reads inside `withTenantTransaction`; the explicit tenant filter backs up RLS. */
export class SqlPortalSummarySource implements PortalSummarySource {
  constructor(private readonly db: Database) {}

  summarize(tenantId: string, query: SummaryQuery): Promise<PortalSummaryAggregates> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const inPeriod = issuedBetween(tenantId, query.from, query.to);

      const [totals] = await tx
        .select({
          count: rows,
          amountPyg,
          otherCurrencyCount: sql<number>`(count(*) filter (where ${documents.currency} <> 'PYG'))::int`,
        })
        .from(documents)
        .innerJoin(tenants, onTenant)
        .where(inPeriod);
      const byType = await tx
        .select({ documentType: documents.documentType, count: rows, amountPyg })
        .from(documents)
        .innerJoin(tenants, onTenant)
        .where(inPeriod)
        .groupBy(documents.documentType);
      const byStatus = await tx
        .select({ status: documents.status, count: rows, amountPyg })
        .from(documents)
        .innerJoin(tenants, onTenant)
        .where(inPeriod)
        .groupBy(documents.status);

      // A document counts once per code, however many times SIFEN repeated it.
      const codes = await tx.execute(sql`
        select m.value ->> 'code' as code, count(distinct d.id)::int as count
        from ${documents} d
        join ${tenants} t on t.id = d.tenant_id and t.environment = d.environment,
          jsonb_array_elements(
            case when jsonb_typeof(d.sifen_messages) = 'array' then d.sifen_messages else '[]'::jsonb end
          ) as m
        where d.tenant_id = ${tenantId} and d.status = 'rejected'
          and d.issued_at >= ${dayStart(query.from)} and d.issued_at < ${dayStart(query.to, 1)}
          and jsonb_typeof(m.value) = 'object' and m.value ->> 'code' is not null
        group by 1 order by 2 desc, 1 limit ${TOP_CODES}`);

      const [pending] = await tx
        .select({
          count: rows,
          overdue: sql<number>`(count(*) filter (where ${documents.signedAt} < ${query.overdueBefore.toISOString()}::timestamptz))::int`,
          dueSoon: sql<number>`(count(*) filter (where ${documents.signedAt} >= ${query.overdueBefore.toISOString()}::timestamptz and ${documents.signedAt} <= ${query.dueSoonBefore.toISOString()}::timestamptz))::int`,
          oldestSignedAt: sql<string | null>`min(${documents.signedAt})`,
        })
        .from(documents)
        .innerJoin(tenants, onTenant)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            sql`${documents.status} in (${sql.join(
              PENDING_STATUSES.map((s) => sql`${s}`),
              sql`, `,
            )})`,
          ),
        );
      const [previous] = await tx
        .select({ total: count() })
        .from(documents)
        .innerJoin(tenants, onTenant)
        .where(issuedBetween(tenantId, query.previousFrom, query.previousTo));

      return {
        totals,
        byType,
        byStatus,
        rejectedTopCodes: (codes as { rows: { code: string; count: number }[] }).rows.map((r) => ({
          code: r.code,
          count: r.count,
        })),
        pending: {
          ...pending,
          oldestSignedAt: pending.oldestSignedAt ? new Date(pending.oldestSignedAt) : null,
        },
        previousCount: previous.total,
      };
    });
  }
}
