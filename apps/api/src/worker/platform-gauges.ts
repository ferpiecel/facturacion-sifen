import { and, count, eq, gt, inArray, isNotNull, min } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { documents, rucBlocks, tenantCertificates, tenants, type Database } from '@sifen/db';
import type { Telemetry } from '../modules/telemetry/application/ports/telemetry.port.js';

/** Same set the portal summary and the deadline watch count as pending: signed, not yet settled. */
const PENDING_STATUSES = ['signed', 'queued', 'submitted'];
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Upper age bound in hours of each bucket (SIFEN's 72 h deadline, ADR-0008). */
const BUCKETS = [
  { label: '<24h', fromHours: 0 },
  { label: '24-48h', fromHours: 24 },
  { label: '48-72h', fromHours: 48 },
  { label: '>72h', fromHours: 72 },
] as const;

export interface PlatformGaugesDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
  readonly now?: () => Date;
}

/**
 * Publishes the cross-tenant gauges of the alert rules (HU-E14-01, plan §13): documents pending by
 * age, tenants paused by a RUC block and the soonest certificate expiry. Read as `platform_admin`
 * (ADR-0005) in one transaction; the results are aggregates, so no tenant, CDC or certificate data
 * reaches a label or a value.
 */
export async function publishPlatformGauges({
  db,
  telemetry,
  now = () => new Date(),
}: PlatformGaugesDeps): Promise<void> {
  const at = now();
  const { pending, blocked, soonest } = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE platform_admin`);
    const signedAges = await tx
      .select({ signedAt: documents.signedAt })
      .from(documents)
      .innerJoin(
        tenants,
        and(eq(tenants.id, documents.tenantId), eq(tenants.environment, documents.environment)),
      )
      .where(and(inArray(documents.status, PENDING_STATUSES), isNotNull(documents.signedAt)));
    const [blockedRow] = await tx
      .select({ total: count(sql`distinct ${rucBlocks.tenantId}`) })
      .from(rucBlocks)
      .innerJoin(
        tenants,
        and(eq(tenants.id, rucBlocks.tenantId), eq(tenants.environment, rucBlocks.environment)),
      )
      .where(gt(rucBlocks.blockedUntil, at));
    const [expiryRow] = await tx
      .select({ notAfter: min(tenantCertificates.notAfter) })
      .from(tenantCertificates)
      .innerJoin(
        tenants,
        and(
          eq(tenants.id, tenantCertificates.tenantId),
          eq(tenants.environment, tenantCertificates.environment),
        ),
      )
      .where(eq(tenantCertificates.status, 'active'));
    return { pending: signedAges, blocked: blockedRow.total, soonest: expiryRow.notAfter };
  });

  const ageHours = pending.flatMap((row) =>
    row.signedAt ? [(at.getTime() - row.signedAt.getTime()) / HOUR_MS] : [],
  );
  for (const [i, bucket] of BUCKETS.entries()) {
    const until = BUCKETS[i + 1]?.fromHours ?? Number.POSITIVE_INFINITY;
    const total = ageHours.filter((h) => h >= bucket.fromHours && h < until).length;
    telemetry.setGauge('de_pending_transmission', total, { bucket: bucket.label });
  }
  telemetry.setGauge('sifen_ruc_blocked_tenants', blocked);
  if (soonest) {
    const notAfter = new Date(soonest);
    telemetry.setGauge(
      'certificate_expiry_days_min',
      Math.floor((notAfter.getTime() - at.getTime()) / DAY_MS),
    );
  }
}
