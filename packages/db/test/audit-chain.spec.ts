import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { verifyAuditChain } from '../src/audit-chain.js';
import { auditLog, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

const GENESIS = '0'.repeat(64);

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function causeMessage(error: unknown): string {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Spec: HU-E13-02. Per-tenant SHA-256 hash chain computed by the database (RNF-08). */
describe('audit_log hash chain', () => {
  let handle: DatabaseHandle | undefined;

  const entry = (tenantId: string, n: number) => ({
    tenantId,
    actorType: 'api_key' as const,
    actorId: 'key-1',
    action: `test.action.${n}`,
    entityType: 'thing',
    entityId: `thing-${n}`,
    before: n === 0 ? null : { n: n - 1 },
    after: { n, texto: 'ñandú' },
  });

  async function seed() {
    const testHandle = await createTestDatabase();
    handle = testHandle;
    const inserted = await testHandle.db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }])
      .returning();
    const tenantA = required(inserted[0], 'tenant A was not inserted').id;
    const tenantB = required(inserted[1], 'tenant B was not inserted').id;
    const append = (tenantId: string, count: number) =>
      withTenantTransaction(testHandle.db, tenantId, async (tx) => {
        for (let n = 0; n < count; n += 1) {
          await tx.insert(auditLog).values(entry(tenantId, n));
        }
      });
    const chainOf = (tenantId: string) =>
      testHandle.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantId))
        .orderBy(asc(auditLog.seq));
    return { db: testHandle.db, tenantA, tenantB, append, chainOf };
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('links each row to the previous hash, starting at the genesis hash', async () => {
    const { tenantA, append, chainOf } = await seed();

    await append(tenantA, 3);
    const rows = await chainOf(tenantA);

    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[0]?.prevHash).toBe(GENESIS);
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(rows[2]?.prevHash).toBe(rows[1]?.hash);
    for (const row of rows) {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(rows.map((row) => row.hash)).size).toBe(3);
  });

  it('keeps independent chains per tenant', async () => {
    const { tenantA, tenantB, append, chainOf } = await seed();

    await append(tenantA, 2);
    await append(tenantB, 2);
    const [a, b] = [await chainOf(tenantA), await chainOf(tenantB)];

    expect(b[0]?.seq).toBe(1);
    expect(b[0]?.prevHash).toBe(GENESIS);
    expect(b[0]?.hash).not.toBe(a[0]?.hash);
    expect(b[1]?.prevHash).toBe(b[0]?.hash);
  });

  it('ignores a hash, prev_hash or seq supplied by the application', async () => {
    const { db, tenantA, append, chainOf } = await seed();
    await append(tenantA, 1);

    await withTenantTransaction(db, tenantA, (tx) =>
      tx
        .insert(auditLog)
        .values({ ...entry(tenantA, 1), hash: 'f'.repeat(64), prevHash: 'e'.repeat(64), seq: 99 }),
    );
    const rows = await chainOf(tenantA);

    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(rows[1]?.hash).not.toBe('f'.repeat(64));
    expect(await verifyAuditChain(db, tenantA)).toEqual({ ok: true, rows: 2 });
  });

  it('verifies an intact chain, and an empty one', async () => {
    const { db, tenantA, tenantB, append } = await seed();
    await append(tenantA, 4);

    expect(await verifyAuditChain(db, tenantA)).toEqual({ ok: true, rows: 4 });
    expect(await verifyAuditChain(db, tenantB)).toEqual({ ok: true, rows: 0 });
  });

  it('reports the first row whose content was tampered with', async () => {
    const { db, tenantA, tenantB, append, chainOf } = await seed();
    await append(tenantA, 4);
    await append(tenantB, 2);
    const target = required((await chainOf(tenantA))[1], 'row 2 missing');

    await db.transaction(async (tx) => {
      await tx.execute(sql`alter table audit_log disable trigger audit_log_append_only`);
      await tx.execute(
        sql`update audit_log set after = '{"n": 666}'::jsonb where id = ${target.id}`,
      );
      await tx.execute(sql`alter table audit_log enable trigger audit_log_append_only`);
    });

    expect(await verifyAuditChain(db, tenantA)).toEqual({
      ok: false,
      rows: 4,
      brokenAt: { id: target.id, seq: 2, reason: 'hash_mismatch' },
    });
    expect(await verifyAuditChain(db, tenantB)).toEqual({ ok: true, rows: 2 });
  });

  it('reports a deleted row as a broken link', async () => {
    const { db, tenantA, append, chainOf } = await seed();
    await append(tenantA, 3);
    const rows = await chainOf(tenantA);
    const removed = required(rows[1], 'row 2 missing');
    const next = required(rows[2], 'row 3 missing');

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE audit_maintenance`);
      await tx.execute(sql`delete from audit_log where id = ${removed.id}`);
    });

    expect(await verifyAuditChain(db, tenantA)).toEqual({
      ok: false,
      rows: 2,
      brokenAt: { id: next.id, seq: 3, reason: 'broken_link' },
    });
  });

  it('serializes concurrent appends for one tenant into a single linear chain', async () => {
    const { db, tenantA, append, chainOf } = await seed();

    await Promise.all(Array.from({ length: 8 }, () => append(tenantA, 3)));
    const rows = await chainOf(tenantA);

    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(new Set(rows.map((row) => row.prevHash)).size).toBe(24);
    expect(await verifyAuditChain(db, tenantA)).toEqual({ ok: true, rows: 24 });
  });

  it('rejects a duplicated (tenant_id, seq) at the constraint level', async () => {
    const { db, tenantA, append } = await seed();
    await append(tenantA, 1);

    const error: unknown = await db
      .transaction(async (tx) => {
        await tx.execute(sql`alter table audit_log disable trigger audit_log_hash_chain`);
        await tx.insert(auditLog).values({ ...entry(tenantA, 5), seq: 1, prevHash: 'a', hash: 'b' });
      })
      .catch((caught: unknown) => caught);

    expect(causeMessage(error)).toMatch(/audit_log_tenant_seq_unique/);
  });
});
