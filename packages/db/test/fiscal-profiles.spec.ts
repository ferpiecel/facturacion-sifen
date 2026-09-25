import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '../src/client.js';
import { tenantFiscalEconomicActivities, tenantFiscalProfiles, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

interface Seed {
  db: Database;
  tenantA: string;
  tenantB: string;
  /** A tenant with no fiscal profile, so CHECK-constraint tests never collide with the seeded PK. */
  tenantC: string;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/**
 * Asserts `promise` rejects with a Postgres error whose message names the
 * given CHECK constraint, so the test actually exercises that constraint
 * instead of failing for an unrelated reason (e.g. a PK collision).
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
 * Spec: HU-E2-01 (DB part). `tenant_fiscal_profiles` and
 * `tenant_fiscal_economic_activities` are tenant-scoped like every other
 * operational table (ADR-0005): one profile row per tenant, isolated by RLS
 * exactly like `api_keys` and `tenant_probe`.
 */
describe('tenant_fiscal_profiles', () => {
  let handle: DatabaseHandle | undefined;

  async function seed(): Promise<Seed> {
    const testHandle = await createTestDatabase();
    handle = testHandle;

    const inserted = await testHandle.db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }, { name: 'Tenant C' }])
      .returning();
    const tenantA = required(inserted[0], 'tenant A was not inserted').id;
    const tenantB = required(inserted[1], 'tenant B was not inserted').id;
    const tenantC = required(inserted[2], 'tenant C was not inserted').id;

    await testHandle.db.insert(tenantFiscalProfiles).values({
      tenantId: tenantA,
      rucBase: '4490207',
      rucDv: 7,
      legalName: 'Tenant A S.A.',
      taxpayerType: 'persona_juridica',
      regimeCode: '1',
    });
    await testHandle.db.insert(tenantFiscalEconomicActivities).values({
      tenantId: tenantA,
      code: '47111',
      description: 'Venta al por menor',
    });

    await testHandle.db.insert(tenantFiscalProfiles).values({
      tenantId: tenantB,
      rucBase: '1234567',
      rucDv: 9,
      legalName: 'Tenant B S.A.',
      taxpayerType: 'persona_juridica',
    });
    await testHandle.db.insert(tenantFiscalEconomicActivities).values({
      tenantId: tenantB,
      code: '47112',
      description: 'Otro rubro',
    });

    return { db: testHandle.db, tenantA, tenantB, tenantC };
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('tenant A sees only its own fiscal profile', async () => {
    const { db, tenantA } = await seed();

    const rows = await withTenantTransaction(db, tenantA, (tx) =>
      tx.select().from(tenantFiscalProfiles),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(tenantA);
    expect(rows[0]?.rucBase).toBe('4490207');
  });

  it('tenant A cannot read or modify tenant B fiscal profile', async () => {
    const { db, tenantA, tenantB } = await seed();

    const rows = await withTenantTransaction(db, tenantA, (tx) =>
      tx.select().from(tenantFiscalProfiles).where(eq(tenantFiscalProfiles.tenantId, tenantB)),
    );
    expect(rows).toHaveLength(0);

    const updated = await withTenantTransaction(db, tenantA, (tx) =>
      tx
        .update(tenantFiscalProfiles)
        .set({ legalName: 'hijacked' })
        .where(eq(tenantFiscalProfiles.tenantId, tenantB))
        .returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('tenant A sees only its own economic activities', async () => {
    const { db, tenantA } = await seed();

    const rows = await withTenantTransaction(db, tenantA, (tx) =>
      tx.select().from(tenantFiscalEconomicActivities),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(tenantA);
    expect(rows[0]?.code).toBe('47111');
  });

  it('rejects a ruc_base outside the 3-8 digit format', async () => {
    const { db, tenantC } = await seed();

    await expectConstraintViolation(
      db.insert(tenantFiscalProfiles).values({
        tenantId: tenantC,
        rucBase: '12',
        rucDv: 6,
        legalName: 'Bad Ruc',
        taxpayerType: 'persona_fisica',
      }),
      'tenant_fiscal_profiles_ruc_base_format',
    );
  });

  it('rejects a ruc_dv outside 0-9', async () => {
    const { db, tenantC } = await seed();

    await expectConstraintViolation(
      db.insert(tenantFiscalProfiles).values({
        tenantId: tenantC,
        rucBase: '1234567',
        rucDv: 10,
        legalName: 'Bad Dv',
        taxpayerType: 'persona_fisica',
      }),
      'tenant_fiscal_profiles_ruc_dv_range',
    );
  });

  it('rejects a regime_code that is not 1-2 digits', async () => {
    const { db, tenantC } = await seed();

    await expectConstraintViolation(
      db.insert(tenantFiscalProfiles).values({
        tenantId: tenantC,
        rucBase: '1234567',
        rucDv: 9,
        legalName: 'Bad Regime',
        taxpayerType: 'persona_fisica',
        regimeCode: 'AB',
      }),
      'tenant_fiscal_profiles_regime_code_format',
    );
  });
});
