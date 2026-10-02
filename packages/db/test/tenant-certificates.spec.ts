import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { tenantCertificates, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E3-01 (DB part). Tenant `.p12` files are stored only sealed, one active per environment. */
describe('tenant_certificates', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const rows = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    const [a, b] = rows.map((row) => row.id);
    return { db: handle.db, a, b };
  }

  const certificate = (
    tenantId: string,
    overrides: Partial<typeof tenantCertificates.$inferInsert> = {},
  ): typeof tenantCertificates.$inferInsert => ({
    tenantId,
    environment: 'test',
    sealed: SEALED,
    fingerprint: FP_A,
    subjectRuc: '80000005-6',
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
    ...overrides,
  });

  const asPlatformAdmin = <T>(db: DatabaseHandle['db'], work: (tx: typeof db) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE platform_admin`);
      return work(tx as unknown as typeof db);
    });

  it('has only the expected columns, the key material only inside sealed', async () => {
    const { db } = await seed();
    const rows = await queryRows<{ column_name: string }>(
      db,
      sql`select column_name from information_schema.columns where table_name = 'tenant_certificates' order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'created_at',
      'environment',
      'fingerprint',
      'id',
      'not_after',
      'not_before',
      'revoked_at',
      'sealed',
      'status',
      'subject_ruc',
      'tenant_id',
    ]);
  });

  it('stores an active certificate by default', async () => {
    const { db, a } = await seed();
    const [row] = await db.insert(tenantCertificates).values(certificate(a)).returning();
    expect(row).toMatchObject({ status: 'active', revokedAt: null, fingerprint: FP_A });
  });

  it('rejects a malformed fingerprint, an unknown status and an inverted validity', async () => {
    const { db, a } = await seed();
    expect(
      await causeOf(db.insert(tenantCertificates).values(certificate(a, { fingerprint: 'XYZ' }))),
    ).toContain('tenant_certificates_fingerprint_format');
    expect(
      await causeOf(db.insert(tenantCertificates).values(certificate(a, { status: 'bogus' }))),
    ).toContain('tenant_certificates_status_valid');
    expect(
      await causeOf(
        db
          .insert(tenantCertificates)
          .values(certificate(a, { notAfter: new Date('2025-01-01T00:00:00Z') })),
      ),
    ).toContain('tenant_certificates_validity_order');
  });

  it('ties revoked_at to the revoked status', async () => {
    const { db, a } = await seed();
    expect(
      await causeOf(db.insert(tenantCertificates).values(certificate(a, { status: 'revoked' }))),
    ).toContain('tenant_certificates_revoked_pair');
    expect(
      await causeOf(
        db.insert(tenantCertificates).values(certificate(a, { revokedAt: new Date() })),
      ),
    ).toContain('tenant_certificates_revoked_pair');
  });

  it('allows one active certificate per tenant and environment', async () => {
    const { db, a, b } = await seed();
    await db.insert(tenantCertificates).values(certificate(a));
    expect(
      await causeOf(db.insert(tenantCertificates).values(certificate(a, { fingerprint: FP_B }))),
    ).toContain('tenant_certificates_one_active_idx');
    await db.insert(tenantCertificates).values(certificate(a, { environment: 'production' }));
    await db.insert(tenantCertificates).values(certificate(b));
    await db
      .insert(tenantCertificates)
      .values(certificate(a, { fingerprint: FP_B, status: 'revoked', revokedAt: new Date() }));
    expect(await db.select().from(tenantCertificates)).toHaveLength(4);
  });

  it('rejects the same certificate twice for a tenant and environment', async () => {
    const { db, a } = await seed();
    await db
      .insert(tenantCertificates)
      .values(certificate(a, { status: 'revoked', revokedAt: new Date() }));
    expect(await causeOf(db.insert(tenantCertificates).values(certificate(a)))).toContain(
      'tenant_certificates_tenant_environment_fingerprint_key',
    );
  });

  it('isolates reads by tenant through RLS', async () => {
    const { db, a, b } = await seed();
    await db.insert(tenantCertificates).values([certificate(a), certificate(b)]);
    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(tenantCertificates));
    expect(seen.map((r) => r.tenantId)).toEqual([a]);
  });

  it('gives app_user SELECT only: insert, update and delete are permission errors', async () => {
    const { db, a } = await seed();
    await db.insert(tenantCertificates).values(certificate(a));
    const attempts = [
      () =>
        withTenantTransaction(db, a, (tx) =>
          tx.insert(tenantCertificates).values(certificate(a, { fingerprint: FP_B })),
        ),
      () =>
        withTenantTransaction(db, a, (tx) =>
          tx.update(tenantCertificates).set({ status: 'revoked', revokedAt: new Date() }),
        ),
      () => withTenantTransaction(db, a, (tx) => tx.delete(tenantCertificates)),
    ];
    for (const attempt of attempts) {
      expect(await causeOf(attempt())).toContain('permission denied for table tenant_certificates');
    }
  });

  it('lets platform_admin insert and revoke but never delete', async () => {
    const { db, a } = await seed();
    await asPlatformAdmin(db, (tx) => tx.insert(tenantCertificates).values(certificate(a)));
    const [revoked] = await asPlatformAdmin(db, (tx) =>
      tx
        .update(tenantCertificates)
        .set({ status: 'revoked', revokedAt: new Date('2026-06-01T00:00:00Z') })
        .where(eq(tenantCertificates.tenantId, a))
        .returning(),
    );
    expect(revoked.status).toBe('revoked');
    expect(await causeOf(asPlatformAdmin(db, (tx) => tx.delete(tenantCertificates)))).toContain(
      'permission denied for table tenant_certificates',
    );
  });

  it('makes everything but the status immutable, even for the owner', async () => {
    const { db, a, b } = await seed();
    await db.insert(tenantCertificates).values(certificate(a));
    const changes: Partial<typeof tenantCertificates.$inferInsert>[] = [
      { tenantId: b },
      { environment: 'production' },
      { sealed: { ...SEALED, keyId: 'other' } },
      { fingerprint: FP_B },
      { subjectRuc: '80000006-4' },
      { notBefore: new Date('2025-01-01T00:00:00Z') },
      { notAfter: new Date('2028-01-01T00:00:00Z') },
    ];
    for (const change of changes) {
      expect(await causeOf(db.update(tenantCertificates).set(change))).toContain('immutable');
    }
  });

  it('only moves active to revoked, never back', async () => {
    const { db, a } = await seed();
    await db.insert(tenantCertificates).values(certificate(a));
    const [row] = await db
      .update(tenantCertificates)
      .set({ status: 'revoked', revokedAt: new Date('2026-06-01T00:00:00Z') })
      .returning();
    expect(row.status).toBe('revoked');
    expect(
      await causeOf(db.update(tenantCertificates).set({ status: 'active', revokedAt: null })),
    ).toContain('invalid status transition');
    expect(
      await causeOf(db.update(tenantCertificates).set({ revokedAt: new Date('2026-07-01') })),
    ).toContain('immutable');
  });
});
