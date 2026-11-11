import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTenant } from './commands.js';
import { OpsArgError, parseOpsArgs } from './args.js';
import { runOpsCommand } from './ops.js';

/** Spec: HU-E15-01, operator commands `subscription:assign` and `payment:record`. */
describe('subscription:* and payment:* operator commands', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('parses subscription:assign with an optional start day', () => {
    expect(parseOpsArgs(['subscription:assign', '--tenant', 't', '--plan', 'pyme'])).toEqual({
      kind: 'subscription:assign',
      tenantId: 't',
      planCode: 'pyme',
      startsOn: undefined,
    });
    expect(() => parseOpsArgs(['subscription:assign', '--tenant', 't'])).toThrow(
      'missing required --plan',
    );
  });

  it('parses payment:record and rejects a zero or non-numeric amount', () => {
    expect(
      parseOpsArgs([
        'payment:record',
        '--tenant',
        't',
        '--amount',
        '99000',
        '--reference',
        'transf-1',
        '--paid-on',
        '2026-10-22',
      ]),
    ).toEqual({
      kind: 'payment:record',
      tenantId: 't',
      amount: 99000,
      reference: 'transf-1',
      paidOn: '2026-10-22',
    });
    expect(() => parseOpsArgs(['payment:record', '--tenant', 't', '--amount', '0'])).toThrow(
      OpsArgError,
    );
    expect(() => parseOpsArgs(['payment:record', '--tenant', 't', '--amount', '1.5'])).toThrow(
      '--amount must be a non-negative whole number',
    );
  });

  it('assigns a plan and records a payment through runOpsCommand', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    await runOpsCommand(handle.db, { kind: 'plan:seed' });
    const { id: tenantId } = await createTenant(handle.db, 'Acme');

    const assigned = await runOpsCommand(handle.db, {
      kind: 'subscription:assign',
      tenantId,
      planCode: 'inicial',
      startsOn: undefined,
    });
    expect(assigned).toMatch(
      /^subscription created: .+ \(inicial from \d{4}-\d{2}-\d{2}, Gs\. 99000\/month, quota 100, overage Gs\. 500\)$/,
    );

    const paid = await runOpsCommand(handle.db, {
      kind: 'payment:record',
      tenantId,
      amount: 99000,
      reference: undefined,
      paidOn: undefined,
    });
    expect(paid).toMatch(/^payment recorded: .+ \(Gs\. 99000, subscription .+\)$/);
  });
});
