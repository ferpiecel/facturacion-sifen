import { createPgliteDatabase, usageCounters, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant } from './commands.js';
import { OpsArgError, parseOpsArgs } from './args.js';
import { runOpsCommand } from './ops.js';
import { seedPlans } from './plan-seed.js';
import { assignSubscription } from './subscription-commands.js';
import { showUsage } from './usage-commands.js';

const NOW = new Date('2026-10-21T15:00:00Z');

/** Spec: HU-E15-02, usage:show reports the month's usage against the subscription snapshot; no enforcement. */
describe('showUsage', () => {
  let handle: DatabaseHandle;
  let tenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    await seedPlans(handle.db, NOW);
    tenantId = (await createTenant(handle.db, 'Acme')).id;
  });
  afterEach(async () => {
    await handle.close();
  });

  const count = (period: string, documentsIssued: number) =>
    handle.db.insert(usageCounters).values({ tenantId, period, documentsIssued });

  it('computes the overage from the subscription quota and overage price', async () => {
    await assignSubscription(handle.db, { tenantId, planCode: 'inicial' }, NOW);
    await count('2026-10-01', 130);

    const report = await showUsage(handle.db, { tenantId }, NOW);

    expect(report).toMatchObject({
      period: '2026-10-01',
      documentsIssued: 130,
      subscription: { planCode: 'inicial', documentQuota: 100, overagePrice: 500 },
      overageDocuments: 30,
      overageAmount: 15000,
      quotaWarning: true,
    });
  });

  it('reports no overage under the quota and warns from 80 percent', async () => {
    await assignSubscription(handle.db, { tenantId, planCode: 'inicial' }, NOW);
    await count('2026-10-01', 79);

    const report = await showUsage(handle.db, { tenantId }, NOW);

    expect(report).toMatchObject({ overageDocuments: 0, overageAmount: 0, quotaWarning: false });
    expect((await showUsage(handle.db, { tenantId, period: '2026-09' }, NOW)).documentsIssued).toBe(
      0,
    );
  });

  it('shows a month before the subscription without its terms, and an empty month as zero', async () => {
    await assignSubscription(handle.db, { tenantId, planCode: 'inicial' }, NOW);
    await count('2026-08-01', 10);

    const before = await showUsage(handle.db, { tenantId, period: '2026-08' }, NOW);

    expect(before).toMatchObject({ documentsIssued: 10, subscription: null, overageAmount: 0 });
  });

  it('refuses a bad period or tenant id', async () => {
    await expect(showUsage(handle.db, { tenantId, period: '2026-13' }, NOW)).rejects.toThrow(
      'period must be YYYY-MM',
    );
    await expect(showUsage(handle.db, { tenantId: 'nope' }, NOW)).rejects.toThrow();
  });

  it('prints the report through the CLI and parses its arguments', async () => {
    await assignSubscription(handle.db, { tenantId, planCode: 'inicial' }, new Date());
    await count(new Date().toISOString().slice(0, 7) + '-01', 90);

    const output = await runOpsCommand(handle.db, {
      kind: 'usage:show',
      tenantId,
      period: undefined,
    });

    expect(output).toContain('inicial, quota 100, overage Gs. 500');
    expect(output).toContain('documents issued: 90');
    expect(output).toContain('overage: 0 documents, Gs. 0');
    expect(output).toContain('warning: 80% of the document quota reached');
    expect(parseOpsArgs(['usage:show', '--tenant', 't', '--period', '2026-10'])).toEqual({
      kind: 'usage:show',
      tenantId: 't',
      period: '2026-10',
    });
    expect(() => parseOpsArgs(['usage:show'])).toThrow(OpsArgError);
  });
});
