import {
  createPgliteDatabase,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpsArgError, parseOpsArgs } from './args.js';
import { listNearDeadline } from './deadline-commands.js';
import { runOpsCommand } from './ops.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

/** Spec: HU-E14 ops gaps. document:deadline lists signed-but-unsettled DE close to the 72 h window (ADR-0008). */
describe('document:deadline', () => {
  let handle: DatabaseHandle;
  let a: string;
  let b: string;
  let sequence = 0;

  async function tenantFixture(name: string) {
    const [tenant] = await handle.db.insert(tenants).values({ name }).returning();
    const [est] = await handle.db
      .insert(tenantEstablishments)
      .values({
        tenantId: tenant.id,
        code: '001',
        address: 'Calle',
        houseNumber: '1',
        departmentCode: '11',
        cityCode: '3432',
        cityDescription: 'X',
      })
      .returning();
    const [point] = await handle.db
      .insert(tenantExpeditionPoints)
      .values({ tenantId: tenant.id, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await handle.db
      .insert(tenantTimbrados)
      .values({ tenantId: tenant.id, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    return { tenantId: tenant.id, est: est.id, point: point.id, timbrado: timbrado.id };
  }

  type Fixture = Awaited<ReturnType<typeof tenantFixture>>;
  const fixtures = new Map<string, Fixture>();

  async function document(tenantId: string, status: string, signedHoursAgo: number | null) {
    const f = fixtures.get(tenantId);
    if (!f) throw new Error('unknown fixture tenant');
    sequence += 1;
    return (
      await handle.db
        .insert(documents)
        .values({
          tenantId,
          environment: 'test',
          timbradoId: f.timbrado,
          establishmentId: f.est,
          expeditionPointId: f.point,
          documentType: 1,
          number: sequence,
          cdc: String(sequence).padStart(44, '0'),
          securityCode: '123456789',
          issuedAt: hoursAgo(100),
          totalAmount: '1000',
          payload: {},
          status,
          signedAt: signedHoursAgo === null ? null : hoursAgo(signedHoursAgo),
          signedXml: signedHoursAgo === null ? null : '<signed/>',
        })
        .returning({ id: documents.id })
    )[0].id;
  }

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    for (const name of ['A', 'B']) {
      const f = await tenantFixture(name);
      fixtures.set(f.tenantId, f);
      if (name === 'A') a = f.tenantId;
      else b = f.tenantId;
    }
  });
  afterEach(async () => {
    await handle.close();
  });

  it('lists pending documents within the window, soonest deadline first, with hours remaining', async () => {
    const close = await document(a, 'queued', 60);
    const closest = await document(a, 'signed', 70.5);
    await document(a, 'queued', 10);
    await document(a, 'accepted', 71);
    await document(a, 'queued', null);

    const rows = await listNearDeadline(handle.db, { tenantId: a, withinHours: 24 }, NOW);

    expect(rows.map((r) => [r.id, r.hoursRemaining])).toEqual([
      [closest, 1.5],
      [close, 12],
    ]);
    expect(rows[0]).toMatchObject({ tenantId: a, status: 'signed', cdc: rows[0].cdc });
  });

  it('keeps overdue documents, at zero hours remaining', async () => {
    const late = await document(a, 'submitted', 80);

    const rows = await listNearDeadline(handle.db, { tenantId: a, withinHours: 24 }, NOW);

    expect(rows.map((r) => [r.id, r.hoursRemaining])).toEqual([[late, 0]]);
  });

  it('reads only the given tenant when one is named, and every tenant otherwise', async () => {
    const forA = await document(a, 'queued', 65);
    const forB = await document(b, 'queued', 68);

    expect((await listNearDeadline(handle.db, { tenantId: a }, NOW)).map((r) => r.id)).toEqual([
      forA,
    ]);
    expect((await listNearDeadline(handle.db, {}, NOW)).map((r) => r.id)).toEqual([forB, forA]);
  });

  it('caps the result and validates its inputs', async () => {
    await document(a, 'queued', 65);
    await document(a, 'queued', 66);

    expect(await listNearDeadline(handle.db, { tenantId: a, limit: 1 }, NOW)).toHaveLength(1);
    await expect(listNearDeadline(handle.db, { tenantId: 'nope' }, NOW)).rejects.toThrow();
    await expect(listNearDeadline(handle.db, { withinHours: 0 }, NOW)).rejects.toThrow('within');
    await expect(listNearDeadline(handle.db, { withinHours: 73 }, NOW)).rejects.toThrow('within');
    await expect(listNearDeadline(handle.db, { limit: 0 }, NOW)).rejects.toThrow('limit');
  });

  it('prints ids and times only, and says so when nothing is close', async () => {
    const empty = await runOpsCommand(handle.db, parseOpsArgs(['document:deadline']));
    expect(empty).toBe('no documents within 24 hours of the 72 h deadline');

    const id = await document(a, 'queued', 66);
    const out = await runOpsCommand(handle.db, parseOpsArgs(['document:deadline', '--tenant', a]));
    expect(out).toContain(id);
    expect(out).toMatch(/\b\d+(\.\d)?h\b/);
  });

  it('parses the flags', () => {
    expect(parseOpsArgs(['document:deadline'])).toEqual({
      kind: 'document:deadline',
      tenantId: undefined,
      withinHours: undefined,
      limit: undefined,
    });
    expect(
      parseOpsArgs(['document:deadline', '--tenant', 't', '--within-hours', '12', '--limit', '5']),
    ).toEqual({ kind: 'document:deadline', tenantId: 't', withinHours: 12, limit: 5 });
    expect(() => parseOpsArgs(['document:deadline', '--limit', 'x'])).toThrow(OpsArgError);
  });
});
