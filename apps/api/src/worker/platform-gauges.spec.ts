import {
  createPgliteDatabase,
  rucBlocks,
  tenantCertificates,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDocuments } from '../../test/support/document-seed.js';
import type { Telemetry } from '../modules/telemetry/application/ports/telemetry.port.js';
import { NOOP_TELEMETRY } from '../modules/telemetry/infrastructure/noop-telemetry.js';
import { publishPlatformGauges } from './platform-gauges.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};

/** Spec: HU-E14-01. Cross-tenant gauges for the alert rules, read as platform_admin, no tenant label. */
describe('publishPlatformGauges', () => {
  let handle: DatabaseHandle;
  const gauges: string[] = [];
  const counters: string[] = [];
  const telemetry: Telemetry = {
    ...NOOP_TELEMETRY,
    increment: (name, by = 1) => void counters.push(`${name}+${String(by)}`),
    setGauge: (name, value, labels) =>
      void gauges.push(`${name}${labels ? JSON.stringify(labels) : ''}=${String(value)}`),
  };

  beforeEach(async () => {
    gauges.length = 0;
    counters.length = 0;
    handle = createPgliteDatabase();
    await handle.migrate();
  });
  afterEach(async () => {
    await handle.close();
  });

  it('reports zeros for every bucket, no blocked tenants and no certificate on an empty platform', async () => {
    await publishPlatformGauges({ db: handle.db, telemetry, now: () => NOW });
    expect(gauges).toEqual([
      'de_pending_transmission{"bucket":"<24h"}=0',
      'de_pending_transmission{"bucket":"24-48h"}=0',
      'de_pending_transmission{"bucket":"48-72h"}=0',
      'de_pending_transmission{"bucket":">72h"}=0',
      'sifen_ruc_blocked_tenants=0',
    ]);
  });

  it('buckets pending documents by age across tenants, counts blocked tenants and the soonest certificate expiry', async () => {
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    const ages = [1, 30, 50, 80];
    await seedDocuments(handle.db, a.id, ['signed', 'queued', 'submitted', 'signed'], (i) => ({
      signedAt: hoursAgo(ages[i]),
      signedXml: '<x/>',
    }));
    await seedDocuments(handle.db, b.id, ['signed', 'approved'], (i) => ({
      signedAt: hoursAgo(i === 0 ? 2 : 100),
      signedXml: '<x/>',
      cdc: `0180069563100100100000${String(i + 71)}12026010111234567891`,
    }));
    await handle.db.insert(rucBlocks).values([
      {
        tenantId: a.id,
        environment: 'test',
        blockedAt: hoursAgo(1),
        blockedUntil: new Date(NOW.getTime() + 600_000),
        reason: 'x',
      },
      {
        tenantId: a.id,
        environment: 'test',
        blockedAt: hoursAgo(5),
        blockedUntil: new Date(NOW.getTime() + 900_000),
        reason: 'x',
      },
      {
        tenantId: b.id,
        environment: 'test',
        blockedAt: hoursAgo(9),
        blockedUntil: hoursAgo(8),
        reason: 'x',
      },
    ]);
    const cert = (tenantId: string, days: number, status = 'active') => ({
      tenantId,
      environment: 'test' as const,
      sealed: SEALED,
      fingerprint: String(days).padStart(64, 'a'),
      subjectRuc: '80000001-7',
      notBefore: hoursAgo(24 * 365),
      notAfter: new Date(NOW.getTime() + days * 86_400_000),
      status,
      revokedAt: status === 'revoked' ? NOW : null,
    });
    await handle.db
      .insert(tenantCertificates)
      .values([cert(a.id, 40), cert(b.id, 12), cert(b.id, 3, 'revoked')]);

    await publishPlatformGauges({ db: handle.db, telemetry, now: () => NOW });

    expect(gauges).toEqual([
      'de_pending_transmission{"bucket":"<24h"}=2',
      'de_pending_transmission{"bucket":"24-48h"}=1',
      'de_pending_transmission{"bucket":"48-72h"}=1',
      'de_pending_transmission{"bucket":">72h"}=1',
      'sifen_ruc_blocked_tenants=1',
      'certificate_expiry_days_min=12',
    ]);
  });

  it('keeps the previous gauge values and counts the failure when a query fails', async () => {
    await publishPlatformGauges({ db: handle.db, telemetry, now: () => NOW });
    gauges.length = 0;
    await handle.close();
    await expect(
      publishPlatformGauges({ db: handle.db, telemetry, now: () => NOW }),
    ).rejects.toThrow();
    expect(gauges).toEqual([]);
    expect(counters).toEqual(['platform_gauge_errors_total+1']);
    handle = createPgliteDatabase();
    await handle.migrate();
  });

  it('aggregates in SQL: the document rows never reach the process', async () => {
    const [a] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }])
      .returning();
    await seedDocuments(handle.db, a.id, ['signed', 'signed'], (i) => ({
      signedAt: hoursAgo(i === 0 ? 0.5 : 71.9),
      signedXml: '<x/>',
    }));
    await publishPlatformGauges({ db: handle.db, telemetry, now: () => NOW });
    expect(gauges.slice(0, 4)).toEqual([
      'de_pending_transmission{"bucket":"<24h"}=1',
      'de_pending_transmission{"bucket":"24-48h"}=0',
      'de_pending_transmission{"bucket":"48-72h"}=1',
      'de_pending_transmission{"bucket":">72h"}=0',
    ]);
  });
});
