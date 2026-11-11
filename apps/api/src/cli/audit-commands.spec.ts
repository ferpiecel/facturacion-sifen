import { auditLog, createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpsArgError, parseOpsArgs } from './args.js';
import { listAudit, verifyAudit } from './audit-commands.js';
import { createTenant } from './commands.js';
import { runOpsCommand } from './ops.js';

/** Spec: HU-E14 ops gaps. audit:list pages a tenant's audit trail; audit:verify checks its hash chain. */
describe('audit commands', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantId = (await createTenant(handle.db, 'A')).id;
    otherTenantId = (await createTenant(handle.db, 'B')).id;
  });
  afterEach(async () => {
    await handle.close();
  });

  // The audit trigger forces occurred_at to now() (entries cannot be backdated), so dates are relative.
  const add = (tenant: string, action: string, id = 'op') =>
    handle.db.insert(auditLog).values({
      tenantId: tenant,
      actorType: 'operator',
      actorId: id,
      action,
      entityType: 'tenant',
      entityId: tenant,
      before: { password: 'hunter2' },
      after: { csc: 'SECRET' },
    });

  it('lists only the tenant entries, oldest first, without before/after payloads', async () => {
    await add(tenantId, 'a.one');
    await add(otherTenantId, 'a.other');
    await add(tenantId, 'a.two');

    const page = await listAudit(handle.db, { tenantId });

    expect(page.entries.map((e) => e.action)).toEqual(['a.one', 'a.two']);
    expect(page.entries[0]).toEqual({
      seq: 1,
      id: page.entries[0].id,
      occurredAt: page.entries[0].occurredAt,
      actorType: 'operator',
      actorId: 'op',
      action: 'a.one',
      entityType: 'tenant',
      entityId: tenantId,
    });
    expect(page.nextAfterSeq).toBeNull();
  });

  const paraguayDay = (offsetDays: number) =>
    new Date(Date.now() - 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

  it('filters by action and by an inclusive Paraguay-calendar date range', async () => {
    await add(tenantId, 'x');
    await add(tenantId, 'y');
    const actions = async (range: { from?: string; to?: string }, action?: string) =>
      (await listAudit(handle.db, { tenantId, action, ...range })).entries.map((e) => e.action);

    expect(await actions({}, 'x')).toEqual(['x']);
    expect(await actions({ from: paraguayDay(0), to: paraguayDay(0) })).toEqual(['x', 'y']);
    expect(await actions({ from: paraguayDay(-3), to: paraguayDay(3) }, 'y')).toEqual(['y']);
    expect(await actions({ from: paraguayDay(1) })).toEqual([]);
    expect(await actions({ to: paraguayDay(-1) })).toEqual([]);
  });

  it('pages by seq with a cursor', async () => {
    for (const n of [1, 2, 3]) await add(tenantId, `a.${String(n)}`);

    const first = await listAudit(handle.db, { tenantId, limit: 2 });
    expect(first.entries.map((e) => e.action)).toEqual(['a.1', 'a.2']);
    expect(first.nextAfterSeq).toBe(2);
    const second = await listAudit(handle.db, {
      tenantId,
      limit: 2,
      afterSeq: first.nextAfterSeq ?? 0,
    });
    expect(second.entries.map((e) => e.action)).toEqual(['a.3']);
    expect(second.nextAfterSeq).toBeNull();
  });

  it('rejects an invalid tenant id, an invalid date and an out-of-range limit', async () => {
    await expect(listAudit(handle.db, { tenantId: 'nope' })).rejects.toThrow();
    await expect(listAudit(handle.db, { tenantId, from: '2026-13-01' })).rejects.toThrow(
      'from must be YYYY-MM-DD',
    );
    await expect(listAudit(handle.db, { tenantId, limit: 0 })).rejects.toThrow('limit');
    await expect(listAudit(handle.db, { tenantId, limit: 501 })).rejects.toThrow('limit');
  });

  it('verifies an intact chain and reports the head', async () => {
    await add(tenantId, 'a');
    await add(tenantId, 'b');

    expect(await verifyAudit(handle.db, { tenantId })).toMatchObject({ ok: true, rows: 2 });
  });

  it('prints ids, actions and actors, never payloads, and pages with a next cursor', async () => {
    await add(tenantId, 'a.one');
    await add(tenantId, 'a.two');

    const out = await runOpsCommand(
      handle.db,
      parseOpsArgs(['audit:list', '--tenant', tenantId, '--limit', '1']),
    );

    expect(out).toContain('a.one');
    expect(out).toContain('operator:op');
    expect(out).toContain('next: --after-seq 1');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('SECRET');
    expect(
      await runOpsCommand(handle.db, parseOpsArgs(['audit:verify', '--tenant', tenantId])),
    ).toBe('audit chain intact: 2 rows (head seq 2)');
  });

  it('says so when nothing matches', async () => {
    expect(await runOpsCommand(handle.db, parseOpsArgs(['audit:list', '--tenant', tenantId]))).toBe(
      'no audit entries',
    );
  });

  it('parses the flags and rejects bad numbers', () => {
    expect(
      parseOpsArgs([
        'audit:list',
        '--tenant',
        't',
        '--action',
        'a',
        '--from',
        '2026-10-01',
        '--to',
        '2026-10-02',
        '--limit',
        '5',
        '--after-seq',
        '9',
      ]),
    ).toEqual({
      kind: 'audit:list',
      tenantId: 't',
      action: 'a',
      from: '2026-10-01',
      to: '2026-10-02',
      limit: 5,
      afterSeq: 9,
    });
    expect(() => parseOpsArgs(['audit:list', '--tenant', 't', '--limit', 'x'])).toThrow(
      OpsArgError,
    );
    expect(() => parseOpsArgs(['audit:verify'])).toThrow('missing required --tenant');
  });
});
