import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '../src/client.js';
import {
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
} from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

interface Seed {
  db: Database;
  tenantA: string;
  tenantB: string;
  /** A tenant with no rows yet, so CHECK-constraint tests never collide with a seeded unique key. */
  tenantC: string;
  establishmentA: string;
  establishmentB: string;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/**
 * Asserts `promise` rejects with a Postgres error whose message names the
 * given constraint, so the test actually exercises that constraint instead
 * of failing for an unrelated reason (e.g. a PK/unique collision).
 */
async function expectConstraintViolation(promise: Promise<unknown>, constraintName: string) {
  await expect(promise).rejects.toThrow();
  try {
    await promise;
    expect.unreachable('expected the insert to reject');
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    expect(causeMessage).toContain(constraintName);
  }
}

/**
 * Spec: HU-E2-02 (DB part). `tenant_establishments`, `tenant_expedition_points`
 * and `tenant_timbrados` are tenant-scoped like every other operational
 * table (ADR-0005), isolated by RLS exactly like `tenant_fiscal_profiles`.
 */
describe('tenant_establishments / tenant_expedition_points / tenant_timbrados', () => {
  let handle: DatabaseHandle | undefined;

  async function seed(): Promise<Seed> {
    const testHandle = await createTestDatabase();
    handle = testHandle;

    const insertedTenants = await testHandle.db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }, { name: 'Tenant C' }])
      .returning();
    const tenantA = required(insertedTenants[0], 'tenant A was not inserted').id;
    const tenantB = required(insertedTenants[1], 'tenant B was not inserted').id;
    const tenantC = required(insertedTenants[2], 'tenant C was not inserted').id;

    const insertedEstablishments = await testHandle.db
      .insert(tenantEstablishments)
      .values([
        {
          tenantId: tenantA,
          code: '001',
          address: 'Av. Mariscal Lopez 123',
          departmentCode: '11',
          districtCode: '145',
          cityCode: '3432',
        },
        {
          tenantId: tenantB,
          code: '001',
          address: 'Av. Espana 456',
          departmentCode: '1',
          districtCode: '1',
          cityCode: '1',
        },
      ])
      .returning();
    const establishmentA = required(insertedEstablishments[0], 'establishment A not inserted').id;
    const establishmentB = required(insertedEstablishments[1], 'establishment B not inserted').id;

    await testHandle.db.insert(tenantExpeditionPoints).values([
      { tenantId: tenantA, establishmentId: establishmentA, code: '001' },
      { tenantId: tenantB, establishmentId: establishmentB, code: '001' },
    ]);

    await testHandle.db.insert(tenantTimbrados).values([
      { tenantId: tenantA, number: '12345678', validFrom: '2024-01-01' },
      { tenantId: tenantB, number: '87654321', validFrom: '2024-01-01', validTo: '2024-12-31' },
    ]);

    return { db: testHandle.db, tenantA, tenantB, tenantC, establishmentA, establishmentB };
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  describe('reads and scoping', () => {
    it('tenant A sees only its own establishment, expedition point and timbrado', async () => {
      const { db, tenantA } = await seed();

      const establishments = await withTenantTransaction(db, tenantA, (tx) =>
        tx.select().from(tenantEstablishments),
      );
      expect(establishments).toHaveLength(1);
      expect(establishments[0]?.tenantId).toBe(tenantA);

      const points = await withTenantTransaction(db, tenantA, (tx) =>
        tx.select().from(tenantExpeditionPoints),
      );
      expect(points).toHaveLength(1);
      expect(points[0]?.tenantId).toBe(tenantA);

      const timbrados = await withTenantTransaction(db, tenantA, (tx) =>
        tx.select().from(tenantTimbrados),
      );
      expect(timbrados).toHaveLength(1);
      expect(timbrados[0]?.number).toBe('12345678');
    });
  });

  describe('CHECK constraints', () => {
    it('rejects an establishment code outside the 3-digit, non-000 format', async () => {
      const { db, tenantC } = await seed();

      await expectConstraintViolation(
        db.insert(tenantEstablishments).values({
          tenantId: tenantC,
          code: '000',
          address: 'Calle Falsa 123',
          departmentCode: '1',
          districtCode: '1',
          cityCode: '1',
        }),
        'tenant_establishments_code_format',
      );
    });

    it('rejects a department code outside 1-2 digits', async () => {
      const { db, tenantC } = await seed();

      await expectConstraintViolation(
        db.insert(tenantEstablishments).values({
          tenantId: tenantC,
          code: '002',
          address: 'Calle Falsa 123',
          departmentCode: '123',
          districtCode: '1',
          cityCode: '1',
        }),
        'tenant_establishments_department_code_format',
      );
    });

    it('rejects a district code outside 1-4 digits', async () => {
      const { db, tenantC } = await seed();

      await expectConstraintViolation(
        db.insert(tenantEstablishments).values({
          tenantId: tenantC,
          code: '002',
          address: 'Calle Falsa 123',
          departmentCode: '1',
          districtCode: '12345',
          cityCode: '1',
        }),
        'tenant_establishments_district_code_format',
      );
    });

    it('rejects a city code outside 1-5 digits', async () => {
      const { db, tenantC } = await seed();

      await expectConstraintViolation(
        db.insert(tenantEstablishments).values({
          tenantId: tenantC,
          code: '002',
          address: 'Calle Falsa 123',
          departmentCode: '1',
          districtCode: '1',
          cityCode: '123456',
        }),
        'tenant_establishments_city_code_format',
      );
    });

    it('rejects an expedition point code outside the 3-digit, non-000 format', async () => {
      const { db, tenantA, establishmentA } = await seed();

      await expectConstraintViolation(
        db.insert(tenantExpeditionPoints).values({
          tenantId: tenantA,
          establishmentId: establishmentA,
          code: '000',
        }),
        'tenant_expedition_points_code_format',
      );
    });

    it('rejects a duplicate expedition point code within the same establishment', async () => {
      const { db, tenantA, establishmentA } = await seed();

      await expect(
        db.insert(tenantExpeditionPoints).values({
          tenantId: tenantA,
          establishmentId: establishmentA,
          code: '001',
        }),
      ).rejects.toThrow();
    });

    it('rejects an expedition point pointing at another tenant establishment (cross-tenant parent)', async () => {
      const { db, tenantA, establishmentB } = await seed();

      await expect(
        db.insert(tenantExpeditionPoints).values({
          tenantId: tenantA,
          establishmentId: establishmentB,
          code: '002',
        }),
      ).rejects.toThrow();
    });

    it('rejects a timbrado number outside the 8-digit, non-all-zero format', async () => {
      const { db, tenantC } = await seed();

      await expectConstraintViolation(
        db.insert(tenantTimbrados).values({
          tenantId: tenantC,
          number: '1234567',
          validFrom: '2024-01-01',
        }),
        'tenant_timbrados_number_format',
      );
    });

    it('rejects a timbrado valid_to before valid_from', async () => {
      const { db, tenantC } = await seed();

      await expectConstraintViolation(
        db.insert(tenantTimbrados).values({
          tenantId: tenantC,
          number: '11112222',
          validFrom: '2024-06-01',
          validTo: '2024-01-01',
        }),
        'tenant_timbrados_valid_to_after_valid_from',
      );
    });

    it('rejects a duplicate timbrado number for the same tenant', async () => {
      const { db, tenantA } = await seed();

      await expect(
        db.insert(tenantTimbrados).values({
          tenantId: tenantA,
          number: '12345678',
          validFrom: '2024-01-01',
        }),
      ).rejects.toThrow();
    });
  });

  describe('RLS write isolation', () => {
    it('app_user with tenant A active cannot insert an establishment for tenant B', async () => {
      const { db, tenantA, tenantB } = await seed();

      await expect(
        withTenantTransaction(db, tenantA, (tx) =>
          tx.insert(tenantEstablishments).values({
            tenantId: tenantB,
            code: '099',
            address: 'Forged address',
            departmentCode: '1',
            districtCode: '1',
            cityCode: '1',
          }),
        ),
      ).rejects.toThrow();
    });

    it('app_user with tenant A active cannot insert an expedition point for tenant B', async () => {
      const { db, tenantA, tenantB, establishmentB } = await seed();

      await expect(
        withTenantTransaction(db, tenantA, (tx) =>
          tx.insert(tenantExpeditionPoints).values({
            tenantId: tenantB,
            establishmentId: establishmentB,
            code: '099',
          }),
        ),
      ).rejects.toThrow();
    });

    it('app_user with tenant A active cannot insert a timbrado for tenant B', async () => {
      const { db, tenantA, tenantB } = await seed();

      await expect(
        withTenantTransaction(db, tenantA, (tx) =>
          tx.insert(tenantTimbrados).values({
            tenantId: tenantB,
            number: '99999999',
            validFrom: '2024-01-01',
          }),
        ),
      ).rejects.toThrow();
    });

    it('app_user with tenant A active: UPDATE/DELETE of tenant B rows affects 0 rows', async () => {
      const { db, tenantA, tenantB } = await seed();

      const updatedEstablishment = await withTenantTransaction(db, tenantA, (tx) =>
        tx
          .update(tenantEstablishments)
          .set({ address: 'hijacked' })
          .where(eq(tenantEstablishments.tenantId, tenantB))
          .returning(),
      );
      expect(updatedEstablishment).toHaveLength(0);

      const deletedPoint = await withTenantTransaction(db, tenantA, (tx) =>
        tx
          .delete(tenantExpeditionPoints)
          .where(eq(tenantExpeditionPoints.tenantId, tenantB))
          .returning(),
      );
      expect(deletedPoint).toHaveLength(0);

      const updatedTimbrado = await withTenantTransaction(db, tenantA, (tx) =>
        tx
          .update(tenantTimbrados)
          .set({ validTo: '2099-01-01' })
          .where(eq(tenantTimbrados.tenantId, tenantB))
          .returning(),
      );
      expect(updatedTimbrado).toHaveLength(0);
    });
  });
});
