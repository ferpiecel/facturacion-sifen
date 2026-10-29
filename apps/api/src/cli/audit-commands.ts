import { and, asc, eq, gt, gte, lt } from 'drizzle-orm';
import {
  assertValidTenantId,
  auditLog,
  verifyAuditChain,
  withTenantTransaction,
  type AuditChainResult,
  type Database,
} from '@sifen/db';

export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LIMIT = 500;

/** One audit row as the operator sees it: never the `before`/`after` payloads or the hash chain. */
export interface AuditListEntry {
  seq: number;
  id: string;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
}

export interface AuditPage {
  entries: AuditListEntry[];
  /** Pass as `afterSeq` to read the next page; null on the last page. */
  nextAfterSeq: number | null;
}

/** `YYYY-MM-DD` to midnight of that day in Paraguay (UTC-03:00, like `usage:show`). */
function parseDay(value: string, flag: string): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00-03:00`) : undefined;
  // Round-trip rejects impossible days such as 2026-02-31, which Date would silently roll over.
  if (
    !date ||
    Number.isNaN(date.getTime()) ||
    new Date(date.getTime() - 3 * 3_600_000).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${flag} must be YYYY-MM-DD`);
  }
  return date;
}

/**
 * Operator CLI (HU-E14): lists a tenant's audit entries oldest first, optionally narrowed by action and
 * by an inclusive Paraguay-calendar date range, paged by `seq`. Read through `withTenantTransaction`, so
 * RLS confines it to the tenant. The payloads (`before`/`after`) are never selected.
 */
export async function listAudit(
  db: Database,
  params: {
    tenantId: string;
    action?: string;
    from?: string;
    to?: string;
    limit?: number;
    afterSeq?: number;
  },
): Promise<AuditPage> {
  assertValidTenantId(params.tenantId);
  const limit = params.limit ?? DEFAULT_AUDIT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
    throw new Error(`limit must be between 1 and ${String(MAX_AUDIT_LIMIT)}`);
  }
  const from = params.from === undefined ? undefined : parseDay(params.from, 'from');
  const toDay = params.to === undefined ? undefined : parseDay(params.to, 'to');
  const toExclusive = toDay && new Date(toDay.getTime() + 24 * 3_600_000);
  const rows = await withTenantTransaction(db, params.tenantId, (tx) =>
    tx
      .select({
        seq: auditLog.seq,
        id: auditLog.id,
        occurredAt: auditLog.occurredAt,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, params.tenantId),
          params.action === undefined ? undefined : eq(auditLog.action, params.action),
          from && gte(auditLog.occurredAt, from),
          toExclusive && lt(auditLog.occurredAt, toExclusive),
          params.afterSeq === undefined ? undefined : gt(auditLog.seq, params.afterSeq),
        ),
      )
      .orderBy(asc(auditLog.seq))
      .limit(limit + 1),
  );
  const entries = rows.slice(0, limit);
  return {
    entries,
    nextAfterSeq: rows.length > limit ? (entries.at(-1)?.seq ?? null) : null,
  };
}

/** Operator CLI (HU-E14): recomputes the tenant's audit hash chain (RNF-08). Read-only. */
export async function verifyAudit(
  db: Database,
  params: { tenantId: string },
): Promise<AuditChainResult> {
  assertValidTenantId(params.tenantId);
  return await withTenantTransaction(db, params.tenantId, (tx) =>
    verifyAuditChain(tx, params.tenantId),
  );
}
