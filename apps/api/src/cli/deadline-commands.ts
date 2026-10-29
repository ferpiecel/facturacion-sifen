import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import {
  assertValidTenantId,
  documents,
  tenants,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import {
  hoursRemaining,
  TRANSMISSION_WINDOW_MS,
  transmissionDeadline,
} from '../modules/transmission/domain/transmission-deadline.js';
import { asPlatformAdmin } from './platform-admin.js';

/** Same set the portal summary and the deadline watch count as pending: signed, not yet settled. */
const PENDING_STATUSES = ['signed', 'queued', 'submitted'];
const HOUR_MS = 3_600_000;
export const DEFAULT_WITHIN_HOURS = 24;
export const DEFAULT_DEADLINE_LIMIT = 100;
const MAX_DEADLINE_LIMIT = 1000;

export interface NearDeadlineDocument {
  id: string;
  tenantId: string;
  cdc: string;
  status: string;
  signedAt: Date;
  deadline: Date;
  /** Hours to the 72 h deadline, to a tenth; 0 once it has passed. */
  hoursRemaining: number;
}

/**
 * Operator CLI (HU-E14, ADR-0008): signed documents SIFEN has not settled whose 72 h window ends within
 * `withinHours` (already overdue ones included, at 0 h), soonest deadline first. With `tenantId` it
 * reads under that tenant's RLS; without it, across tenants as `platform_admin` (the deliberate
 * cross-tenant role of ADR-0005). Only ids, status and times: never the payload or XML.
 */
export async function listNearDeadline(
  db: Database,
  params: { tenantId?: string; withinHours?: number; limit?: number },
  now: Date,
): Promise<NearDeadlineDocument[]> {
  if (params.tenantId !== undefined) assertValidTenantId(params.tenantId);
  const withinHours = params.withinHours ?? DEFAULT_WITHIN_HOURS;
  const limit = params.limit ?? DEFAULT_DEADLINE_LIMIT;
  const windowHours = TRANSMISSION_WINDOW_MS / HOUR_MS;
  if (!Number.isInteger(withinHours) || withinHours < 1 || withinHours > windowHours) {
    throw new Error(`within-hours must be a whole number between 1 and ${String(windowHours)}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DEADLINE_LIMIT) {
    throw new Error(`limit must be between 1 and ${String(MAX_DEADLINE_LIMIT)}`);
  }
  // deadline = signedAt + 72 h <= now + withinHours  <=>  signedAt <= now - (72 - withinHours) h
  const signedUntil = new Date(now.getTime() - (windowHours - withinHours) * HOUR_MS);
  const read = async (tx: Database) => {
    const rows = await tx
      .select({
        id: documents.id,
        tenantId: documents.tenantId,
        cdc: documents.cdc,
        status: documents.status,
        signedAt: documents.signedAt,
      })
      .from(documents)
      .innerJoin(
        tenants,
        and(eq(tenants.id, documents.tenantId), eq(tenants.environment, documents.environment)),
      )
      .where(
        and(
          params.tenantId === undefined ? undefined : eq(documents.tenantId, params.tenantId),
          inArray(documents.status, PENDING_STATUSES),
          isNotNull(documents.signedAt),
          lte(documents.signedAt, signedUntil),
        ),
      )
      .orderBy(asc(documents.signedAt), asc(documents.id))
      .limit(limit);
    return rows.flatMap((row) => {
      if (!row.signedAt) return [];
      const deadline = transmissionDeadline(row.signedAt);
      return [
        {
          id: row.id,
          tenantId: row.tenantId,
          cdc: row.cdc,
          status: row.status,
          signedAt: row.signedAt,
          deadline,
          hoursRemaining: hoursRemaining(deadline, now),
        },
      ];
    });
  };
  return params.tenantId === undefined
    ? await asPlatformAdmin(
        db,
        {
          purpose: 'document:deadline',
          scope: ['documents', 'tenants'],
          rowCount: (rows) => rows.length,
        },
        read,
      )
    : await withTenantTransaction(db, params.tenantId, read);
}
