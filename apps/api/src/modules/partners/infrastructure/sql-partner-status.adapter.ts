import { sql } from 'drizzle-orm';
import { withAppRoleTransaction, withPartnerTransaction, type Database } from '@sifen/db';
import type {
  PartnerStatusSnapshot,
  PartnerStatusSource,
} from '../application/partner-status-source.port.js';

async function rows<T>(
  tx: { execute: (query: ReturnType<typeof sql>) => PromiseLike<unknown> },
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  return ((await tx.execute(query)) as { rows: T[] }).rows;
}

/**
 * Reads through the `partner_viewer` role (migration 0044): the database itself limits the rows to the partner's
 * tenants and the columns to operational ones, so even a bug here could not select a CDC or an amount.
 */
export class SqlPartnerStatusSource implements PartnerStatusSource {
  constructor(private readonly db: Database) {}

  async isMember(userId: string, partnerId: string): Promise<boolean> {
    const [row] = await withAppRoleTransaction(this.db, (tx) =>
      rows<{ ok: boolean }>(tx, sql`select user_in_partner(${userId}, ${partnerId}) as ok`),
    );
    return row.ok;
  }

  read(partnerId: string): Promise<PartnerStatusSnapshot> {
    return withPartnerTransaction(this.db, partnerId, async (tx) => {
      const tenantRows = await rows<{ id: string; name: string; environment: string }>(
        tx,
        sql`select id, name, environment from tenants order by name, id`,
      );
      const certificates = await rows<{
        tenant_id: string;
        environment: string;
        status: string;
        not_after: Date | string;
      }>(tx, sql`select tenant_id, environment, status, not_after from tenant_certificates`);
      const counts = await rows<{ tenant_id: string; status: string; total: number }>(
        tx,
        sql`select tenant_id, status, count(*)::int as total from documents group by tenant_id, status`,
      );
      return {
        tenants: tenantRows,
        certificates: certificates.map((c) => ({
          tenantId: c.tenant_id,
          environment: c.environment,
          status: c.status,
          notAfter: new Date(c.not_after),
        })),
        documentCounts: counts.map((c) => ({
          tenantId: c.tenant_id,
          status: c.status,
          total: c.total,
        })),
      };
    });
  }
}
