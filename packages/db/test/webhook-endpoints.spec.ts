import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { tenants, webhookEndpoints } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const SEALED_2 = {
  ...{ v: 1, keyId: 'k2', wrappedKey: 'AA==', nonce: 'AA==', tag: 'AA==', ciphertext: 'BB==' },
};
const DAY = 86_400_000;
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E11-01 (DB part). The HMAC signing secret is stored only sealed, never in clear. */
describe('webhook_endpoints', () => {
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

  const endpoint = (
    tenantId: string,
    overrides: Partial<typeof webhookEndpoints.$inferInsert> = {},
  ): typeof webhookEndpoints.$inferInsert => ({
    tenantId,
    url: 'https://example.com/hooks/sifen',
    sealed: SEALED,
    ...overrides,
  });

  it('keeps the signing secret only inside sealed; defaults to an active, all-events endpoint', async () => {
    const { db, a } = await seed();
    const columns = await queryRows<{ column_name: string }>(
      db,
      sql`select column_name from information_schema.columns where table_name = 'webhook_endpoints' order by column_name`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      [
        'active',
        'created_at',
        'events',
        'id',
        'previous_expires_at',
        'previous_sealed',
        'sealed',
        'secret_version',
        'tenant_id',
        'updated_at',
        'url',
      ].sort(),
    );
    const [row] = await db.insert(webhookEndpoints).values(endpoint(a)).returning();
    expect(row).toMatchObject({ active: true, events: [], secretVersion: 1, previousSealed: null });
  });

  it.each([
    'http://example.com/hook',
    'ftp://example.com',
    'https://user:pw@example.com/hook',
    'https://exa mple.com',
    'https:///hook',
    'https://:443/hook',
    'https://?x=1',
    'HTTPS://example.com/hook',
    'Https://example.com/hook',
    'https://example.com:99999999/hook',
    `https://example.com/${'a'.repeat(2048)}`,
  ])('rejects the endpoint url %s', async (url) => {
    const { db, a } = await seed();
    expect(await causeOf(db.insert(webhookEndpoints).values(endpoint(a, { url })))).toContain(
      'webhook_endpoints_url_https',
    );
  });

  it('rejects unknown event names and a half-set rotation overlap', async () => {
    const { db, a } = await seed();
    expect(
      await causeOf(db.insert(webhookEndpoints).values(endpoint(a, { events: ['document.nope'] }))),
    ).toContain('webhook_endpoints_events_valid');
    expect(
      await causeOf(db.insert(webhookEndpoints).values(endpoint(a, { previousSealed: SEALED }))),
    ).toContain('webhook_endpoints_previous_pair');
  });

  it('isolates by tenant through RLS; app_user can insert and update, never delete', async () => {
    const { db, a, b } = await seed();
    await db.insert(webhookEndpoints).values([endpoint(a), endpoint(b)]);
    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(webhookEndpoints));
    expect(seen.map((r) => r.tenantId)).toEqual([a]);
    await withTenantTransaction(db, a, (tx) => tx.update(webhookEndpoints).set({ active: false }));
    expect(
      await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(webhookEndpoints))),
    ).toContain('permission denied for table webhook_endpoints');
  });

  it('refuses to move an endpoint to another tenant', async () => {
    const { db, a, b } = await seed();
    await db.insert(webhookEndpoints).values(endpoint(a));
    expect(await causeOf(db.update(webhookEndpoints).set({ tenantId: b }))).toContain('immutable');
  });

  it('rejects duplicated event names; an empty filter still means every event', async () => {
    const { db, a } = await seed();
    expect(
      await causeOf(
        db
          .insert(webhookEndpoints)
          .values(endpoint(a, { events: ['document.approved', 'document.approved'] })),
      ),
    ).toContain('webhook_endpoints_events_unique');
    await db.insert(webhookEndpoints).values(endpoint(a, { events: ['document.approved'] }));
    await db.insert(webhookEndpoints).values(endpoint(a, { events: [] }));
  });

  describe('secret rotation (enforced by the guard trigger, as app_user)', () => {
    const asTenant = <T>(
      db: DatabaseHandle['db'],
      tenantId: string,
      change: Partial<typeof webhookEndpoints.$inferInsert>,
    ) => withTenantTransaction(db, tenantId, (tx) => tx.update(webhookEndpoints).set(change));
    const rotation = (graceMs = DAY): Partial<typeof webhookEndpoints.$inferInsert> => ({
      sealed: SEALED_2,
      secretVersion: 2,
      previousSealed: SEALED,
      previousExpiresAt: new Date(Date.now() + graceMs),
    });

    it('lets sealed change only as a rotation: version + 1, old secret kept for a grace period', async () => {
      const { db, a } = await seed();
      await db.insert(webhookEndpoints).values(endpoint(a));
      await asTenant(db, a, rotation());
      const [row] = await db.select().from(webhookEndpoints);
      expect(row).toMatchObject({ secretVersion: 2, sealed: SEALED_2, previousSealed: SEALED });
    });

    it.each([
      ['sealed changed without a version bump', { sealed: SEALED_2 }, 'rotation'],
      ['version bumped without a new sealed', { secretVersion: 2 }, 'secret_version'],
      ['version jumping by two', { ...rotation(), secretVersion: 3 }, 'secret_version'],
      ['version going backwards', { ...rotation(), secretVersion: 0 }, 'secret_version'],
      [
        'previous_sealed that is not the old secret',
        { ...rotation(), previousSealed: SEALED_2 },
        'rotation',
      ],
      ['an overlap already expired', rotation(-1000), 'rotation'],
      ['an overlap longer than 7 days', rotation(8 * DAY), 'rotation'],
    ])('rejects %s', async (_name, change, expected) => {
      const { db, a } = await seed();
      await db.insert(webhookEndpoints).values(endpoint(a));
      expect(await causeOf(asTenant(db, a, change))).toContain(expected);
    });

    it('does not let previous_* be set or cleared outside a rotation, except once it expired', async () => {
      const { db, a } = await seed();
      await db.insert(webhookEndpoints).values(endpoint(a));
      expect(
        await causeOf(
          asTenant(db, a, {
            previousSealed: SEALED_2,
            previousExpiresAt: new Date(Date.now() + DAY),
          }),
        ),
      ).toContain('rotation');
      await db.delete(webhookEndpoints);
      await db.insert(webhookEndpoints).values(
        endpoint(a, {
          secretVersion: 2,
          previousSealed: SEALED,
          previousExpiresAt: new Date(Date.now() + DAY),
        }),
      );
      expect(
        await causeOf(asTenant(db, a, { previousSealed: null, previousExpiresAt: null })),
      ).toContain('rotation');
      await db.delete(webhookEndpoints);
      await db
        .insert(webhookEndpoints)
        .values(
          endpoint(a, { previousSealed: SEALED, previousExpiresAt: new Date(Date.now() - DAY) }),
        );
      await asTenant(db, a, { previousSealed: null, previousExpiresAt: null });
      const [row] = await db.select().from(webhookEndpoints);
      expect(row.previousSealed).toBeNull();
    });
  });

  it('maintains updated_at on every update', async () => {
    const { db, a } = await seed();
    const past = new Date('2020-01-01T00:00:00Z');
    await db.insert(webhookEndpoints).values(endpoint(a, { updatedAt: past }));
    const [row] = await db
      .update(webhookEndpoints)
      .set({ active: false, updatedAt: past })
      .returning();
    expect(row.updatedAt.getTime()).toBeGreaterThan(past.getTime());
  });
});
