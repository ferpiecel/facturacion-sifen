import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { withPlatformAdminTransaction } from '../src/platform-admin-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

type Entry = {
  seq: string;
  actor: string;
  purpose: string;
  scope: string[];
  row_count: number | null;
  prev_hash: string;
  hash: string;
  expected: string;
};

const ctx = { actor: 'ops-cli:test', purpose: 'usage:show', scope: ['usage_counters'] };

/** Spec: platform-audit. Every platform_admin use leaves an append-only, hash-chained record. */
describe('platform_audit_log', () => {
  let handle: DatabaseHandle | undefined;

  async function setup() {
    handle = await createTestDatabase();
    return handle.db;
  }

  async function entries(db: DatabaseHandle['db']) {
    return queryRows<Entry>(
      db,
      sql`select seq::text, actor, purpose, scope, row_count, prev_hash, hash,
        platform_audit_log_compute_hash(id, seq, occurred_at, actor, purpose, scope, row_count, prev_hash) as expected
        from platform_audit_log order by seq`,
    );
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('records actor, purpose, scope and row count in the same transaction', async () => {
    const db = await setup();

    const result = await withPlatformAdminTransaction(
      db,
      { ...ctx, rowCount: (rows: number[]) => rows.length },
      () => Promise.resolve([1, 2, 3]),
    );

    expect(result).toEqual([1, 2, 3]);
    const [entry, ...rest] = await entries(db);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      seq: '1',
      actor: 'ops-cli:test',
      purpose: 'usage:show',
      scope: ['usage_counters'],
      row_count: 3,
      prev_hash: '0'.repeat(64),
    });
    expect(entry.hash).toBe(entry.expected);
  });

  it('chains consecutive entries', async () => {
    const db = await setup();
    await withPlatformAdminTransaction(db, ctx, () => Promise.resolve(1));
    await withPlatformAdminTransaction(db, { ...ctx, purpose: 'plan:list' }, () =>
      Promise.resolve(1),
    );

    const [first, second] = await entries(db);

    expect(second.seq).toBe('2');
    expect(second.prev_hash).toBe(first.hash);
    expect(second.hash).toBe(second.expected);
  });

  it('rolls the operation back when fn throws and writes no record', async () => {
    const db = await setup();

    await expect(
      withPlatformAdminTransaction(db, ctx, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await entries(db)).toEqual([]);
  });

  it('rejects a blank actor or purpose before touching the database', async () => {
    const db = await setup();

    await expect(
      withPlatformAdminTransaction(db, { ...ctx, actor: ' ' }, () => Promise.resolve(1)),
    ).rejects.toThrow(/actor/);
    await expect(
      withPlatformAdminTransaction(db, { ...ctx, purpose: '' }, () => Promise.resolve(1)),
    ).rejects.toThrow(/purpose/);
  });

  it('skips the record inside the throttle window of the same actor and purpose', async () => {
    const db = await setup();
    const system = {
      actor: 'system:gauges',
      purpose: 'platform-gauges',
      scope: ['documents'],
      throttleSeconds: 900,
    };

    await withPlatformAdminTransaction(db, system, () => Promise.resolve(1));
    await withPlatformAdminTransaction(db, system, () => Promise.resolve(1));
    await withPlatformAdminTransaction(db, { ...system, purpose: 'tenant-directory' }, () =>
      Promise.resolve(1),
    );

    expect((await entries(db)).map((entry) => entry.purpose)).toEqual([
      'platform-gauges',
      'tenant-directory',
    ]);
  });

  it.each([
    ['UPDATE', sql`update platform_audit_log set actor = 'x'`],
    ['DELETE', sql`delete from platform_audit_log`],
    ['TRUNCATE', sql`truncate platform_audit_log`],
  ])('rejects %s even for platform_admin', async (_name, statement) => {
    const db = await setup();
    await withPlatformAdminTransaction(db, ctx, () => Promise.resolve(1));

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE platform_admin`);
        await tx.execute(statement);
      }),
    ).rejects.toThrow();
    expect(await entries(db)).toHaveLength(1);
  });

  it('is invisible and not writable for app_user', async () => {
    const db = await setup();
    await withPlatformAdminTransaction(db, ctx, () => Promise.resolve(1));

    const asApp = (statement: ReturnType<typeof sql>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(statement);
      });

    await expect(asApp(sql`select * from platform_audit_log`)).rejects.toThrow();
    await expect(
      asApp(
        sql`insert into platform_audit_log (actor, purpose, scope) values ('x', 'y', '[]'::jsonb)`,
      ),
    ).rejects.toThrow();
  });
});
