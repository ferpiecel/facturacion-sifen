import { and, eq } from 'drizzle-orm';
import { auditLog, createPgliteDatabase, rucBlocks, tenants, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpsArgError, parseOpsArgs } from './args.js';
import { runOpsCommand } from './ops.js';
import { unblockRuc } from './ruc-unblock.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

/** Spec: HU-E6-05 / HU-E14 ops gaps. ruc:unblock lets an operator lift a tenant's active RUC pause. */
describe('ruc:unblock', () => {
  let handle: DatabaseHandle;
  let a: string;
  let b: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    [{ id: a }, { id: b }] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning({ id: tenants.id });
  });
  afterEach(async () => {
    await handle.close();
  });

  const block = (tenantId: string, until: Date, environment: 'test' | 'production' = 'test') =>
    handle.db.insert(rucBlocks).values({
      tenantId,
      environment,
      blockedAt: minutes(-5),
      blockedUntil: until,
      reason: 'RUC bloqueado',
    });
  const rows = (tenantId: string) =>
    handle.db.select().from(rucBlocks).where(eq(rucBlocks.tenantId, tenantId));

  it('lifts every active pause of the tenant and audits it with actor and reason', async () => {
    await block(a, minutes(20));
    await block(a, minutes(25));
    await block(a, minutes(-1)); // already over
    await block(b, minutes(20)); // other tenant

    const result = await unblockRuc(
      handle.db,
      { tenantId: a, actor: 'ana', reason: 'DNIT confirmed the RUC is clear' },
      NOW,
    );

    expect(result).toEqual({ tenantId: a, lifted: 2, previousUntil: minutes(25) });
    const mine = await rows(a);
    expect(mine.filter((r) => r.liftedAt !== null)).toHaveLength(2);
    expect(
      mine.find((r) => r.blockedUntil.getTime() === minutes(-1).getTime())?.liftedAt,
    ).toBeNull();
    expect(mine.find((r) => r.liftedAt)).toMatchObject({
      liftedAt: NOW,
      liftedBy: 'ana',
      liftReason: 'DNIT confirmed the RUC is clear',
    });
    expect((await rows(b))[0].liftedAt).toBeNull();
    const [entry] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, a), eq(auditLog.action, 'ruc_block.lifted')));
    expect(entry).toMatchObject({ actorType: 'operator', actorId: 'ana', entityId: a });
    expect(JSON.stringify(entry.after)).toContain('DNIT confirmed');
  });

  it('refuses when there is no active block, and writes nothing', async () => {
    await block(a, minutes(-1));
    await block(a, minutes(20), 'production'); // not the tenant's current environment

    await expect(
      unblockRuc(handle.db, { tenantId: a, actor: 'ana', reason: 'x' }, NOW),
    ).rejects.toThrow('no active RUC block');
    await expect(
      unblockRuc(handle.db, { tenantId: b, actor: 'ana', reason: 'x' }, NOW),
    ).rejects.toThrow('no active RUC block');
    expect((await rows(a)).every((r) => r.liftedAt === null)).toBe(true);
    expect(await handle.db.select().from(auditLog)).toHaveLength(0);
  });

  it('is not repeatable: a second lift finds nothing active', async () => {
    await block(a, minutes(20));
    await unblockRuc(handle.db, { tenantId: a, actor: 'ana', reason: 'first' }, NOW);

    await expect(
      unblockRuc(handle.db, { tenantId: a, actor: 'ana', reason: 'again' }, NOW),
    ).rejects.toThrow('no active RUC block');
  });

  it('validates tenant, actor and reason before touching the database', async () => {
    await expect(
      unblockRuc(handle.db, { tenantId: 'nope', actor: 'ana', reason: 'x' }, NOW),
    ).rejects.toThrow();
    await expect(
      unblockRuc(handle.db, { tenantId: a, actor: ' ', reason: 'x' }, NOW),
    ).rejects.toThrow('actor');
    await expect(
      unblockRuc(handle.db, { tenantId: a, actor: 'ana', reason: ' ' }, NOW),
    ).rejects.toThrow('reason');
    await expect(
      unblockRuc(handle.db, { tenantId: a, actor: 'ana', reason: 'x'.repeat(501) }, NOW),
    ).rejects.toThrow('reason');
  });

  it('parses the flags, requires --actor and --reason, and prints a one-line result', async () => {
    expect(
      parseOpsArgs(['ruc:unblock', '--tenant', 't', '--actor', 'ana', '--reason', 'cleared']),
    ).toEqual({ kind: 'ruc:unblock', tenantId: 't', actor: 'ana', reason: 'cleared' });
    expect(() => parseOpsArgs(['ruc:unblock', '--tenant', 't', '--reason', 'r'])).toThrow(
      'missing required --actor',
    );
    expect(() => parseOpsArgs(['ruc:unblock', '--tenant', 't', '--actor', 'a'])).toThrow(
      OpsArgError,
    );

    await block(a, new Date(Date.now() + 3_600_000));
    const out = await runOpsCommand(
      handle.db,
      parseOpsArgs(['ruc:unblock', '--tenant', a, '--actor', 'ana', '--reason', 'cleared']),
    );
    expect(out).toBe(`RUC pause lifted for tenant ${a}: 1 block(s)`);
  });
});
