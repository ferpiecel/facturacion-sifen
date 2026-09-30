import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { tenants } from '../src/schema.js';
import { createTestDatabase } from './support/harness.js';

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/** Spec: HU-E2-04 / ADR-0012. `tenants.environment` gates the test-literal policy per tenant. */
describe('tenants.environment', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('defaults a new tenant to "test"', async () => {
    handle = await createTestDatabase();

    const [row] = await handle.db.insert(tenants).values({ name: 'Default Tenant' }).returning();

    expect(required(row, 'tenant was not inserted').environment).toBe('test');
  });

  it('accepts an explicit "production" environment', async () => {
    handle = await createTestDatabase();

    const [row] = await handle.db
      .insert(tenants)
      .values({ name: 'Prod Tenant', environment: 'production' })
      .returning();

    expect(required(row, 'tenant was not inserted').environment).toBe('production');
  });

  it('can be switched from "test" to "production"', async () => {
    handle = await createTestDatabase();
    const [inserted] = await handle.db
      .insert(tenants)
      .values({ name: 'Switch Tenant' })
      .returning();
    const tenantId = required(inserted, 'tenant was not inserted').id;

    const [updated] = await handle.db
      .update(tenants)
      .set({ environment: 'production' })
      .where(eq(tenants.id, tenantId))
      .returning();

    expect(required(updated, 'tenant was not updated').environment).toBe('production');
  });

  it('rejects a value outside the "tenant_environment" enum', async () => {
    handle = await createTestDatabase();

    // Exercises the DB-level enum guard directly, bypassing the TS union so
    // an invalid runtime value (e.g. a stale client) still fails in Postgres.
    const invalidValues = { name: 'Bad Tenant', environment: 'staging' } as unknown as {
      name: string;
      environment: 'test' | 'production';
    };
    const rejection = handle.db.insert(tenants).values(invalidValues);

    await expect(rejection).rejects.toThrow();
    const cause = await rejection.catch((error: unknown) => (error as { cause?: unknown }).cause);
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain('tenant_environment');
  });
});
