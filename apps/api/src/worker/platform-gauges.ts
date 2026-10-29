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

async function readAggregates(db: Database, at: Date) {
  const hoursAgo = (hours: number) => new Date(at.getTime() - hours * HOUR_MS);
  const [, h24, h48, h72] = BUCKETS.map((bucket) => hoursAgo(bucket.fromHours));
  const bucket = sql<string>`case
    when ${documents.signedAt} > ${h24} then ${BUCKETS[0].label}
    when ${documents.signedAt} > ${h48} then ${BUCKETS[1].label}
    when ${documents.signedAt} > ${h72} then ${BUCKETS[2].label}
    else ${BUCKETS[3].label} end`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE platform_admin`);
    const rows = await tx
      .select({ bucket, total: count() })
      .from(documents)
      .innerJoin(
        tenants,
        and(eq(tenants.id, documents.tenantId), eq(tenants.environment, documents.environment)),
      )
      .where(and(inArray(documents.status, PENDING_STATUSES), isNotNull(documents.signedAt)))
      .groupBy(sql`1`);
    const [blockedRow] = await tx
      .select({ total: count(sql`distinct ${rucBlocks.tenantId}`) })
      .from(rucBlocks)
      .innerJoin(
        tenants,
        and(eq(tenants.id, rucBlocks.tenantId), eq(tenants.environment, rucBlocks.environment)),
      )
      .where(gt(rucBlocks.blockedUntil, at));
    const [expiryRow] = await tx
      .select({ notAfter: min(tenantCertificates.notAfter), active: count() })
      .from(tenantCertificates)
      .innerJoin(
        tenants,
        and(
          eq(tenants.id, tenantCertificates.tenantId),
          eq(tenants.environment, tenantCertificates.environment),
        ),
      )
      .where(eq(tenantCertificates.status, 'active'));
    return {
      counts: new Map(rows.map((row) => [row.bucket, row.total])),
      blocked: blockedRow.total,
      soonest: expiryRow.notAfter,
      active: expiryRow.active,
    };
  });
}

/**
 * Publishes the cross-tenant gauges of the alert rules (HU-E14-01, plan §13): documents pending by
 * age, tenants paused by a RUC block and the soonest certificate expiry plus the active certificate count. Read as `platform_admin`
 * (ADR-0005) in one transaction; the results are aggregates, so no tenant, CDC or certificate data
 * reaches a label or a value.
 */
export async function publishPlatformGauges({
  db,
  telemetry,
  now = () => new Date(),
}: PlatformGaugesDeps): Promise<void> {
  const at = now();
  let result;
  try {
    result = await readAggregates(db, at);
  } catch (error) {
    // Deliberate: the previously published gauges stay (a stale value beats a false zero that would
    // silence the alerts); the failure is visible through `platform_gauge_errors_total`.
    telemetry.increment('platform_gauge_errors_total');
    throw error;
  }
  const { counts, blocked, soonest, active } = result;
  for (const bucket of BUCKETS) {
    telemetry.setGauge('de_pending_transmission', counts.get(bucket.label) ?? 0, {
      bucket: bucket.label,
    });
  }
  telemetry.setGauge('sifen_ruc_blocked_tenants', blocked);
  telemetry.setGauge('certificate_active_count', active);
  // With no active certificate there is no expiry to report: the gauge is not republished (the
  // alert rules gate on `certificate_active_count`, so a stale value never fires).
  if (soonest) {
    const notAfter = new Date(soonest);
    telemetry.setGauge(
      'certificate_expiry_days_min',
      Math.floor((notAfter.getTime() - at.getTime()) / DAY_MS),
    );
  }
}
