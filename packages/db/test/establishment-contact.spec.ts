import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { tenantEstablishments, tenants } from '../src/schema.js';
import { createTestDatabase } from './support/harness.js';

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/**
 * Spec: HU-E6-02 (DB part). gEmis needs dTelEmi and dEmailE (required in DE_v150.xsd) and may
 * carry dDenSuc; they live on the establishment and are nullable only for pre-existing rows.
 */
describe('tenant_establishments contact columns', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    let n = 0;
    const establishment = (overrides: Partial<typeof tenantEstablishments.$inferInsert> = {}) => {
      n += 1;
      return {
        tenantId: tenant.id,
        code: String(n).padStart(3, '0'),
        address: 'Av. Mariscal Lopez 123',
        houseNumber: '123',
        departmentCode: '11',
        cityCode: '3432',
        cityDescription: 'Asuncion',
        ...overrides,
      };
    };
    return { db: handle.db, establishment };
  }

  it('stores phone, email and commercial name, and leaves them null by default', async () => {
    const { db, establishment } = await seed();
    const [bare] = await db.insert(tenantEstablishments).values(establishment()).returning();
    expect(bare).toMatchObject({ phone: null, email: null, commercialName: null });
    const [full] = await db
      .insert(tenantEstablishments)
      .values(
        establishment({
          phone: '0973-000000',
          email: 'emisor@test.com',
          commercialName: 'Casa Matriz',
        }),
      )
      .returning();
    expect(full).toMatchObject({
      phone: '0973-000000',
      email: 'emisor@test.com',
      commercialName: 'Casa Matriz',
    });
  });

  it.each(['12345', '   ', '1'.repeat(16)])('rejects the phone %j', async (phone) => {
    const { db, establishment } = await seed();
    const message = await causeOf(db.insert(tenantEstablishments).values(establishment({ phone })));
    expect(message).toMatch(/tenant_establishments_phone_length|value too long/);
  });

  it.each(['no-at-sign', 'a@b', '@test.com', 'a b@test.com', 'a@test.c'])(
    'rejects the email %j',
    async (email) => {
      const { db, establishment } = await seed();
      expect(
        await causeOf(db.insert(tenantEstablishments).values(establishment({ email }))),
      ).toContain('tenant_establishments_email_format');
    },
  );

  it('rejects an empty or blank commercial name', async () => {
    const { db, establishment } = await seed();
    for (const commercialName of ['', '   ']) {
      expect(
        await causeOf(db.insert(tenantEstablishments).values(establishment({ commercialName }))),
      ).toContain('tenant_establishments_commercial_name_length');
    }
  });
});
