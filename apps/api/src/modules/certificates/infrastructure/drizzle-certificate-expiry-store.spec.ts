import {
  createPgliteDatabase,
  tenantCertificates,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleCertificateExpiryStore } from './drizzle-certificate-expiry-store.js';

const AT = new Date('2026-12-01T12:00:00.000Z');
const NOT_AFTER = new Date('2027-01-01T00:00:00.000Z');
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const alert = (certificateId: string, thresholdDays = 60) => ({
  certificateId,
  environment: 'test',
  fingerprint: 'a'.repeat(64),
  notAfter: NOT_AFTER,
  thresholdDays,
  daysRemaining: 30,
});

/** Spec: HU-E3-03. */
describe('createDrizzleCertificateExpiryStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
  });
  afterEach(async () => {
    await handle.close();
  });

  const certificate = async (
    over: Partial<typeof tenantCertificates.$inferInsert> = {},
    tenant = tenantId,
  ) =>
    (
      await handle.db
        .insert(tenantCertificates)
        .values({
          tenantId: tenant,
          environment: 'test',
          sealed: SEALED,
          fingerprint: 'a'.repeat(64),
          subjectRuc: '80000001-7',
          notBefore: new Date('2025-01-01T00:00:00.000Z'),
          notAfter: NOT_AFTER,
          ...over,
        })
        .returning()
    )[0];
  const endpoint = async (
    over: Partial<typeof webhookEndpoints.$inferInsert> = {},
    tenant = tenantId,
  ) =>
    (
      await handle.db
        .insert(webhookEndpoints)
        .values({ tenantId: tenant, url: 'https://h.example.com/x', sealed: SEALED, ...over })
        .returning()
    )[0].id;
  const store = (tenant = tenantId) =>
    createDrizzleCertificateExpiryStore({ db: handle.db, tenantId: tenant });

  describe('findActive', () => {
    it('returns the tenant active certificate for its own environment', async () => {
      const row = await certificate();
      expect(await store().findActive()).toEqual([
        { id: row.id, environment: 'test', fingerprint: 'a'.repeat(64), notAfter: NOT_AFTER },
      ]);
    });

    it('ignores revoked, other-environment and other-tenant certificates', async () => {
      await certificate({ status: 'revoked', revokedAt: AT });
      await certificate({ environment: 'production', fingerprint: 'b'.repeat(64) });
      await certificate({ fingerprint: 'c'.repeat(64) }, otherTenantId);
      expect(await store().findActive()).toEqual([]);
    });
  });

  describe('enqueue', () => {
    it('writes one pending delivery per active matching endpoint with the minimal envelope', async () => {
      const row = await certificate();
      const all = await endpoint();
      const filtered = await endpoint({ events: ['certificate.expiring'] });
      await endpoint({ events: ['document.created'] });
      await endpoint({ active: false });
      await endpoint({}, otherTenantId);

      await store().enqueue([alert(row.id)], AT);

      const rows = await handle.db.select().from(webhookDeliveries);
      expect(rows.map((r) => r.endpointId).sort()).toEqual([all, filtered].sort());
      expect(rows[0]).toMatchObject({
        tenantId,
        eventType: 'certificate.expiring',
        status: 'pending',
        nextAttemptAt: AT,
      });
      expect(rows[0].payload).toMatchObject({
        type: 'certificate.expiring',
        tenant_id: tenantId,
        data: { certificate_id: row.id, threshold_days: 60, days_remaining: 30 },
      });
      expect(JSON.stringify(rows[0].payload)).not.toContain('ciphertext');
    });

    it('does not repeat an alert for the same certificate and threshold, but sends a new threshold', async () => {
      const row = await certificate();
      await endpoint();
      await store().enqueue([alert(row.id, 60)], AT);
      await store().enqueue([alert(row.id, 60)], new Date(AT.getTime() + 3_600_000));
      expect(await handle.db.select().from(webhookDeliveries)).toHaveLength(1);
      await store().enqueue([alert(row.id, 30)], AT);
      expect(await handle.db.select().from(webhookDeliveries)).toHaveLength(2);
    });

    it('writes nothing without endpoints', async () => {
      const row = await certificate();
      await store().enqueue([alert(row.id)], AT);
      expect(await handle.db.select().from(webhookDeliveries)).toEqual([]);
    });
  });
});
