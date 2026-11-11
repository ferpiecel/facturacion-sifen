import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterEach, describe, expect, it } from 'vitest';
import { OpsArgError, parseOpsArgs, type OpsCommand } from './args.js';
import { runOpsCommand } from './ops.js';

/** Spec: HU-E15-01, operator commands `plan:seed`, `plan:list` and `plan:price-set`. */
describe('plan:* operator commands', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  describe('parseOpsArgs', () => {
    it('parses plan:seed and plan:list without flags and rejects stray arguments', () => {
      expect(parseOpsArgs(['plan:seed'])).toEqual({ kind: 'plan:seed' });
      expect(parseOpsArgs(['plan:list'])).toEqual({ kind: 'plan:list' });
      expect(() => parseOpsArgs(['plan:seed', 'extra'])).toThrow(OpsArgError);
    });

    it('parses plan:price-set with repeatable tiers', () => {
      expect(
        parseOpsArgs([
          'plan:price-set',
          '--plan',
          'partner',
          '--monthly',
          '0',
          '--included',
          '0',
          '--overage',
          '300',
          '--valid-from',
          '2026-11-01',
          '--tier',
          '0:300',
          '--tier',
          '10000:200',
        ]),
      ).toEqual({
        kind: 'plan:price-set',
        planCode: 'partner',
        monthlyPrice: 0,
        includedDocuments: 0,
        overagePrice: 300,
        validFrom: '2026-11-01',
        tiers: [
          { fromDocuments: 0, unitPrice: 300 },
          { fromDocuments: 10000, unitPrice: 200 },
        ],
      });
    });

    it('rejects a missing flag, a non-numeric amount and a malformed tier', () => {
      const base = ['plan:price-set', '--plan', 'x', '--included', '1', '--overage', '1'];
      expect(() => parseOpsArgs([...base, '--valid-from', '2026-11-01'])).toThrow(
        'missing required --monthly',
      );
      expect(() =>
        parseOpsArgs([...base, '--monthly', '9.5', '--valid-from', '2026-11-01']),
      ).toThrow('--monthly must be a non-negative whole number');
      expect(() =>
        parseOpsArgs([...base, '--monthly', '1', '--valid-from', '2026-11-01', '--tier', '1:2:3']),
      ).toThrow('--tier must be <from-documents>:<unit-price>');
      expect(() =>
        parseOpsArgs([...base, '--monthly', '1', '--valid-from', '2026-11-01', '--tier', '5']),
      ).toThrow('--tier must be <from-documents>:<unit-price>');
    });
  });

  it('seeds, lists and re-prices through runOpsCommand', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    expect(await runOpsCommand(handle.db, { kind: 'plan:seed' })).toMatch(/^plans priced: /);
    expect(await runOpsCommand(handle.db, { kind: 'plan:seed' })).toBe(
      'plans already priced: nothing changed',
    );
    const listing = await runOpsCommand(handle.db, { kind: 'plan:list' });
    expect(listing).toContain('inicial [direct] Gs. 99000/month, 100 documents, overage Gs. 500');
    expect(listing).toContain('partner [partner] Gs. 0/month');
    expect(listing).toContain('tiers from 0: Gs. 300; from 10000: Gs. 200');

    const set: OpsCommand = {
      kind: 'plan:price-set',
      planCode: 'inicial',
      monthlyPrice: 120000,
      includedDocuments: 150,
      overagePrice: 450,
      validFrom: '2099-01-01',
      tiers: [],
    };
    expect(await runOpsCommand(handle.db, set)).toBe('plan price set: inicial from 2099-01-01');
    expect(await runOpsCommand(handle.db, set)).toBe('plan price unchanged: inicial');
  });
});
