import { userInfo } from 'node:os';
import { createPgliteDatabase, rucBlocks, type Database, type DatabaseHandle } from '@sifen/db';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant } from './commands.js';
import { unblockRuc } from './ruc-unblock.js';
import { listExpiringCertificates } from './certificate-expiring.js';
import { listNearDeadline } from './deadline-commands.js';
import { listPlans, setPlanPrice } from './plan-commands.js';
import { seedPlans } from './plan-seed.js';
import { recordPayment, assignSubscription } from './subscription-commands.js';
import { showUsage } from './usage-commands.js';

const NOW = new Date('2026-10-21T15:00:00Z');

type AuditRow = { actor: string; purpose: string; scope: string[]; row_count: number | null };

async function auditTrail(db: Database): Promise<AuditRow[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE platform_admin`);
    const result = (await tx.execute(
      sql`select actor, purpose, scope, row_count from platform_audit_log order by seq`,
    )) as { rows: AuditRow[] };
    return result.rows;
  });
}

/** Spec: platform-audit. Every ops command that runs as platform_admin leaves an audit record. */
describe('ops commands audit their platform_admin use', () => {
  let handle: DatabaseHandle;
  let tenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantId = (await createTenant(handle.db, 'Acme')).id;
  });
  afterEach(async () => {
    await handle.close();
  });

  const purposes = async () => (await auditTrail(handle.db)).map((row) => row.purpose);

  it('records the operator and the purpose of each cross-tenant command', async () => {
    await seedPlans(handle.db, NOW);
    await listPlans(handle.db, NOW);
    await setPlanPrice(handle.db, {
      planCode: 'pyme',
      monthlyPrice: 250000,
      includedDocuments: 600,
      overagePrice: 350,
      validFrom: '2026-12-01',
      tiers: [],
    });
    await assignSubscription(handle.db, { tenantId, planCode: 'inicial' }, NOW);
    await recordPayment(handle.db, { tenantId, amount: 150000 }, NOW);
    await showUsage(handle.db, { tenantId }, NOW);
    await listNearDeadline(handle.db, {}, NOW);
    await listExpiringCertificates(handle.db, { days: 30 }, NOW);

    expect(await purposes()).toEqual([
      'plan:seed',
      'plan:list',
      'plan:price-set',
      'subscription:assign',
      'payment:record',
      'usage:show',
      'document:deadline',
      'certificate:expiring',
    ]);
    const [first] = await auditTrail(handle.db);
    expect(first.actor).toBe(`ops-cli:${userInfo().username}`);
  });

  it('records the row count of a listing', async () => {
    await listNearDeadline(handle.db, {}, NOW);

    expect(await auditTrail(handle.db)).toMatchObject([
      { purpose: 'document:deadline', scope: ['documents', 'tenants'], row_count: 0 },
    ]);
  });

  it('does not use platform_admin, nor audit, when a tenant is given', async () => {
    await listNearDeadline(handle.db, { tenantId }, NOW);
    await listExpiringCertificates(handle.db, { days: 30, tenantId }, NOW);

    expect(await purposes()).toEqual([]);
  });

  it('audits ruc:unblock, and writes no audit row when it is refused', async () => {
    await expect(
      unblockRuc(handle.db, { tenantId, actor: 'ana', reason: 'x' }, NOW),
    ).rejects.toThrow('no active RUC block');
    expect(await purposes()).toEqual([]);

    await handle.db.insert(rucBlocks).values({
      tenantId,
      environment: 'test',
      blockedAt: NOW,
      blockedUntil: new Date(NOW.getTime() + 3_600_000),
      reason: 'RUC bloqueado',
    });
    await unblockRuc(handle.db, { tenantId, actor: 'ana', reason: 'clear' }, NOW);

    expect(await auditTrail(handle.db)).toMatchObject([
      {
        actor: `ops-cli:${userInfo().username}`,
        purpose: 'ruc:unblock',
        scope: ['ruc_blocks', 'tenants'],
      },
    ]);
  });
});
