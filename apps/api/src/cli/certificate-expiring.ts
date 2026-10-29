import { and, asc, eq, lte } from 'drizzle-orm';
import {
  assertValidTenantId,
  tenantCertificates,
  tenants,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import { asPlatformAdmin } from './platform-admin.js';

const DAY_MS = 86_400_000;
const MAX_DAYS = 365;

export interface ExpiringCertificate {
  id: string;
  tenantId: string;
  environment: string;
  fingerprint: string;
  notAfter: Date;
  /** Whole days left, rounded down; negative once the certificate expired. */
  daysRemaining: number;
}

/**
 * Operator CLI (HU-E14, HU-E3-03): active certificates of each tenant's current environment that expire
 * within `days`, soonest first (an expired but still active one stays, with a negative count). With
 * `tenantId` it reads under that tenant's RLS; without it, across tenants as `platform_admin`
 * (ADR-0005). Facts only (ids, public fingerprint, dates): the sealed `.p12` is never selected.
 */
export async function listExpiringCertificates(
  db: Database,
  params: { days: number; tenantId?: string },
  now: Date,
): Promise<ExpiringCertificate[]> {
  if (params.tenantId !== undefined) assertValidTenantId(params.tenantId);
  if (!Number.isInteger(params.days) || params.days < 1 || params.days > MAX_DAYS) {
    throw new Error(`days must be a whole number between 1 and ${String(MAX_DAYS)}`);
  }
  const until = new Date(now.getTime() + params.days * DAY_MS);
  const read = async (tx: Database) => {
    const rows = await tx
      .select({
        id: tenantCertificates.id,
        tenantId: tenantCertificates.tenantId,
        environment: tenantCertificates.environment,
        fingerprint: tenantCertificates.fingerprint,
        notAfter: tenantCertificates.notAfter,
      })
      .from(tenantCertificates)
      .innerJoin(
        tenants,
        and(
          eq(tenants.id, tenantCertificates.tenantId),
          eq(tenants.environment, tenantCertificates.environment),
        ),
      )
      .where(
        and(
          params.tenantId === undefined
            ? undefined
            : eq(tenantCertificates.tenantId, params.tenantId),
          eq(tenantCertificates.status, 'active'),
          lte(tenantCertificates.notAfter, until),
        ),
      )
      .orderBy(asc(tenantCertificates.notAfter), asc(tenantCertificates.id));
    return rows.map((row) => ({
      ...row,
      daysRemaining: Math.floor((row.notAfter.getTime() - now.getTime()) / DAY_MS),
    }));
  };
  return params.tenantId === undefined
    ? await asPlatformAdmin(db, read)
    : await withTenantTransaction(db, params.tenantId, read);
}
