import { sql } from 'drizzle-orm';
import { withAppRoleTransaction, type Database } from '@sifen/db';
import type {
  NewSession,
  PromotedSession,
  SessionRecord,
  SessionStore,
  TenantMembership,
} from '../../application/ports/session-store.port.js';

interface SessionRow {
  id: string;
  user_id: string;
  active_tenant_id: string | null;
  mfa_verified_at: Date | string | null;
  access_expires_at: Date | string;
  refresh_expires_at: Date | string;
}

const toRecord = (row: SessionRow): SessionRecord => ({
  sessionId: row.id,
  userId: row.user_id,
  activeTenantId: row.active_tenant_id,
  mfaVerified: row.mfa_verified_at !== null,
  accessExpiresAt: new Date(row.access_expires_at),
  refreshExpiresAt: new Date(row.refresh_expires_at),
});

/**
 * Sessions through the SECURITY DEFINER functions of migration 0039 on the pre-tenant `app_user` path:
 * the runtime connection never touches `user_sessions` directly and needs no `platform_admin`.
 */
export class SqlSessionStore implements SessionStore {
  constructor(private readonly db: Database) {}

  private async rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return withAppRoleTransaction(this.db, async (tx) => {
      const result = (await tx.execute(query)) as { rows: T[] };
      return result.rows;
    });
  }

  async create(input: NewSession): Promise<string | null> {
    const row = (
      await this.rows<{ id: string | null }>(
        sql`select create_user_session(${input.userId}, ${input.accessHash}, ${input.refreshHash}, ${input.accessExpiresAt.toISOString()}, ${input.refreshExpiresAt.toISOString()}, ${input.absoluteExpiresAt.toISOString()}, ${input.mfaVerified}) as id`,
      )
    ).at(0);
    return row?.id ?? null;
  }

  async resolve(accessHash: string): Promise<SessionRecord | null> {
    const row = (
      await this.rows<SessionRow>(sql`select * from resolve_user_session(${accessHash})`)
    ).at(0);
    return row ? toRecord(row) : null;
  }

  async rotate(
    oldRefreshHash: string,
    newAccessHash: string,
    newRefreshHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<SessionRecord | null> {
    const row = (
      await this.rows<SessionRow>(
        sql`select * from rotate_user_session(${oldRefreshHash}, ${newAccessHash}, ${newRefreshHash}, ${accessExpiresAt.toISOString()}, ${refreshExpiresAt.toISOString()})`,
      )
    ).at(0);
    return row ? toRecord(row) : null;
  }

  async promote(pendingSessionId: string, next: PromotedSession): Promise<string | null> {
    const row = (
      await this.rows<{ id: string | null }>(
        sql`select promote_user_session(${pendingSessionId}, ${next.accessHash}, ${next.refreshHash}, ${next.accessExpiresAt.toISOString()}, ${next.refreshExpiresAt.toISOString()}, ${next.absoluteExpiresAt.toISOString()}) as id`,
      )
    ).at(0);
    return row?.id ?? null;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.rows(sql`select revoke_user_session(${sessionId})`);
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const row = (
      await this.rows<{ n: number }>(sql`select revoke_user_sessions(${userId}) as n`)
    ).at(0);
    return row?.n ?? 0;
  }

  async listMemberships(userId: string): Promise<TenantMembership[]> {
    const rows = await this.rows<{ tenant_id: string; tenant_name: string; role: string }>(
      sql`select * from list_user_memberships(${userId})`,
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, tenantName: r.tenant_name, role: r.role }));
  }

  async setActiveTenant(sessionId: string, tenantId: string): Promise<boolean> {
    const row = (
      await this.rows<{ ok: boolean }>(
        sql`select set_user_session_tenant(${sessionId}, ${tenantId}) as ok`,
      )
    ).at(0);
    return row?.ok === true;
  }
}
