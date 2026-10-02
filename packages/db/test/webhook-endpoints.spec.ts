import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { tenants, webhookEndpoints } from '../src/schema.js';
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
});
