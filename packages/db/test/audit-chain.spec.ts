import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { verifyAuditChain } from '../src/audit-chain.js';
import { MissingTenantContextError } from '../src/errors.js';
import { auditLog, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

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
    action: `test.action.${String(n)}`,
    entityType: 'thing',
    entityId: `thing-${String(n)}`,
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
    expect(await verifyAuditChain(db, tenantA)).toMatchObject({ ok: true, rows: 2 });
  });

  it('verifies an intact chain, and an empty one', async () => {
    const { db, tenantA, tenantB, append } = await seed();
    await append(tenantA, 4);

    expect(await verifyAuditChain(db, tenantA)).toMatchObject({ ok: true, rows: 4 });
    expect(await verifyAuditChain(db, tenantB)).toMatchObject({ ok: true, rows: 0 });
  });

  it('chains rows written by the system actor and verifies them with the rest', async () => {
    const { db, tenantA, append } = await seed();
    await append(tenantA, 2);
    await withTenantTransaction(db, tenantA, (tx) =>
      tx.insert(auditLog).values({
        tenantId: tenantA,
        actorType: 'system',
        actorId: 'transmission-worker',
        action: 'document.hold_placed',
        entityType: 'document',
        entityId: 'doc-1',
        before: { transmissionHold: null },
        after: { transmissionHold: 'recovery:0420-unresolved' },
      }),
    );
    await append(tenantA, 1);

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantA))
      .orderBy(asc(auditLog.seq));
    expect(rows.map((row) => row.actorType)).toEqual([
      expect.not.stringMatching(/^system$/),
      expect.not.stringMatching(/^system$/),
      'system',
      expect.not.stringMatching(/^system$/),
    ]);
    expect(await verifyAuditChain(db, tenantA)).toMatchObject({ ok: true, rows: 4 });
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
    expect(await verifyAuditChain(db, tenantB)).toMatchObject({ ok: true, rows: 2 });
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

  // pglite multiplexes one session, so transactions cannot truly overlap there.
  it.runIf(process.env.DB_TEST_DRIVER === 'postgres')(
    'serializes concurrent appends for one tenant into a single linear chain',
    async () => {
      const { db, tenantA, append, chainOf } = await seed();

      await Promise.all(Array.from({ length: 8 }, () => append(tenantA, 3)));
      const rows = await chainOf(tenantA);

      expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
      expect(new Set(rows.map((row) => row.prevHash)).size).toBe(24);
      expect(await verifyAuditChain(db, tenantA)).toMatchObject({ ok: true, rows: 24 });
    },
  );

  it('returns the chain head so it can be anchored externally', async () => {
    const { db, tenantA, tenantB, append, chainOf } = await seed();
    await append(tenantA, 3);
    const rows = await chainOf(tenantA);

    expect(await verifyAuditChain(db, tenantA)).toEqual({
      ok: true,
      rows: 3,
      headSeq: 3,
      headHash: rows[2]?.hash,
    });
    expect(await verifyAuditChain(db, tenantB)).toEqual({
      ok: true,
      rows: 0,
      headSeq: 0,
      headHash: GENESIS,
    });
  });

  it('verifies across keyset batches and still finds tampering in a later batch', async () => {
    const { db, tenantA, append, chainOf } = await seed();
    await append(tenantA, 5);
    const target = required((await chainOf(tenantA))[3], 'row 4 missing');

    expect(await verifyAuditChain(db, tenantA, { batchSize: 2 })).toMatchObject({
      ok: true,
      rows: 5,
      headSeq: 5,
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`alter table audit_log disable trigger audit_log_append_only`);
      await tx.execute(sql`update audit_log set actor_id = 'evil' where id = ${target.id}`);
      await tx.execute(sql`alter table audit_log enable trigger audit_log_append_only`);
    });

    expect(await verifyAuditChain(db, tenantA, { batchSize: 2 })).toEqual({
      ok: false,
      rows: 5,
      brokenAt: { id: target.id, seq: 4, reason: 'hash_mismatch' },
    });
  });

  it('fails loudly when the session has no matching tenant context', async () => {
    const { db, tenantA, tenantB, append } = await seed();
    await append(tenantA, 1);

    const noContext: unknown = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        return verifyAuditChain(tx, tenantA);
      })
      .catch((caught: unknown) => caught);
    const wrongTenant: unknown = await withTenantTransaction(db, tenantB, (tx) =>
      verifyAuditChain(tx, tenantA),
    ).catch((caught: unknown) => caught);

    expect(noContext).toBeInstanceOf(MissingTenantContextError);
    expect(wrongTenant).toBeInstanceOf(MissingTenantContextError);
    expect(
      await withTenantTransaction(db, tenantA, (tx) => verifyAuditChain(tx, tenantA)),
    ).toMatchObject({
      ok: true,
      rows: 1,
    });
  });

  it('starts from a trusted checkpoint, so retention purges do not break verification', async () => {
    const { db, tenantA, append, chainOf } = await seed();
    await append(tenantA, 4);
    const rows = await chainOf(tenantA);
    const second = required(rows[1], 'row 2 missing');
    const third = required(rows[2], 'row 3 missing');
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE audit_maintenance`);
      await tx.execute(sql`delete from audit_log where seq <= 2`);
    });
    const checkpoint = { seq: 2, hash: second.hash };

    expect(await verifyAuditChain(db, tenantA)).toEqual({
      ok: false,
      rows: 2,
      brokenAt: { id: third.id, seq: 3, reason: 'broken_link' },
    });
    expect(await verifyAuditChain(db, tenantA, { checkpoint })).toMatchObject({
      ok: true,
      rows: 2,
      headSeq: 4,
    });
    expect(
      await verifyAuditChain(db, tenantA, { checkpoint: { seq: 2, hash: 'a'.repeat(64) } }),
    ).toEqual({
      ok: false,
      rows: 2,
      brokenAt: { id: third.id, seq: 3, reason: 'broken_link' },
    });
  });

  it('flags a checkpoint that disagrees with the stored row at that seq', async () => {
    const { db, tenantA, append, chainOf } = await seed();
    await append(tenantA, 3);
    const second = required((await chainOf(tenantA))[1], 'row 2 missing');

    expect(
      await verifyAuditChain(db, tenantA, { checkpoint: { seq: 2, hash: 'a'.repeat(64) } }),
    ).toEqual({
      ok: false,
      rows: 1,
      brokenAt: { id: second.id, seq: 2, reason: 'checkpoint_mismatch' },
    });
  });

  // pglite runs as a superuser (RLS is bypassed), so only real Postgres can
  // prove the backfill works for a non-superuser table owner under FORCE RLS.
  it.runIf(process.env.DB_TEST_DRIVER === 'postgres')(
    'backfill rebuilds the chain as a non-superuser owner despite FORCE ROW LEVEL SECURITY',
    async () => {
      const { db, tenantA, tenantB, append, chainOf } = await seed();
      // Separate transactions: rows of one transaction share occurred_at.
      for (const tenant of [tenantA, tenantA, tenantA, tenantB, tenantB]) {
        await append(tenant, 1);
      }
      const original = [...(await chainOf(tenantA)), ...(await chainOf(tenantB))].map(
        (row) => row.hash,
      );
      const rollback = new Error('rollback');
      const outcome: { visible?: string; forced?: boolean; hashes?: string[]; a?: unknown } = {};

      await db
        .transaction(async (tx) => {
          await tx.execute(sql`create role chain_owner nologin`);
          await tx.execute(sql`alter table audit_log owner to chain_owner`);
          await tx.execute(sql`alter function audit_log_backfill_chain() owner to chain_owner`);
          await tx.execute(sql`alter table audit_log disable trigger audit_log_append_only`);
          await tx.execute(sql`update audit_log set seq = -seq, prev_hash = '', hash = ''`);
          await tx.execute(sql`alter table audit_log enable trigger audit_log_append_only`);
          await tx.execute(sql`SET LOCAL ROLE chain_owner`);
          outcome.visible = (
            await queryRows<{ count: string }>(
              tx,
              sql`select count(*)::text as count from audit_log`,
            )
          )[0]?.count;
          await tx.execute(sql`select audit_log_backfill_chain()`);
          await tx.execute(sql`RESET ROLE`);
          outcome.forced = (
            await queryRows<{ f: boolean }>(
              tx,
              sql`select relforcerowsecurity as f from pg_class where oid = 'audit_log'::regclass`,
            )
          )[0]?.f;
          outcome.hashes = (
            await queryRows<{ hash: string }>(
              tx,
              sql`select hash from audit_log order by tenant_id = ${tenantB}, seq`,
            )
          ).map((row) => row.hash);
          outcome.a = await verifyAuditChain(tx, tenantA);
          throw rollback;
        })
        .catch((caught: unknown) => {
          if (caught !== rollback) throw caught;
        });

      expect(outcome.visible).toBe('0');
      expect(outcome.forced).toBe(true);
      expect(outcome.a).toMatchObject({ ok: true, rows: 3, headSeq: 3 });
      expect(outcome.hashes).toEqual(original);
    },
  );

  it('rejects a duplicated (tenant_id, seq) at the constraint level', async () => {
    const { db, tenantA, append } = await seed();
    await append(tenantA, 1);

    const error: unknown = await db
      .transaction(async (tx) => {
        await tx.execute(sql`alter table audit_log disable trigger audit_log_hash_chain`);
        await tx
          .insert(auditLog)
          .values({ ...entry(tenantA, 5), seq: 1, prevHash: 'a', hash: 'b' });
      })
      .catch((caught: unknown) => caught);

    expect(causeMessage(error)).toMatch(/audit_log_tenant_seq_unique/);
  });
});
