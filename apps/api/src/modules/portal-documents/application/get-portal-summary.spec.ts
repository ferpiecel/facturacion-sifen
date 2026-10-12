import { describe, expect, it, vi } from 'vitest';
import { InvalidSummaryQueryError } from '../domain/summary-period.js';
import { createGetPortalSummary } from './get-portal-summary.js';
import type {
  PortalSummaryAggregates,
  PortalSummarySource,
} from './ports/portal-summary-source.port.js';

const NOW = new Date('2026-03-31T15:00:00Z');

function aggregates(overrides: Partial<PortalSummaryAggregates> = {}): PortalSummaryAggregates {
  return {
    totals: { count: 0, amountPyg: '0.00000000', otherCurrencyCount: 0 },
    byType: [],
    byStatus: [],
    rejectedTopCodes: [],
    pending: { count: 0, overdue: 0, dueSoon: 0, oldestSignedAt: null },
    previousCount: 0,
    ...overrides,
  };
}

function setup(result = aggregates()) {
  const summarize = vi.fn<PortalSummarySource['summarize']>().mockResolvedValue(result);
  const run = createGetPortalSummary({ source: { summarize }, now: () => NOW });
  return { run, summarize };
}

describe('createGetPortalSummary (HU-E12-03)', () => {
  it('asks the source for the default period and the 72 h / 12 h cut-offs of the injected clock', async () => {
    const { run, summarize } = setup();

    const summary = await run('tenant-1', {});

    expect(summary).toMatchObject({ from: '2026-03-02', to: '2026-03-31' });
    expect(summarize).toHaveBeenCalledWith('tenant-1', {
      from: '2026-03-02',
      to: '2026-03-31',
      previousFrom: '2026-01-31',
      previousTo: '2026-03-01',
      overdueBefore: new Date('2026-03-28T15:00:00Z'),
      dueSoonBefore: new Date('2026-03-29T03:00:00Z'),
    });
  });

  it('maps types, trims decimals and merges the types the portal has no code for', async () => {
    const { run } = setup(
      aggregates({
        totals: { count: 6, amountPyg: '1650000.50000000', otherCurrencyCount: 1 },
        byType: [
          { documentType: 1, count: 3, amountPyg: '1100000.00000000' },
          { documentType: 5, count: 1, amountPyg: '50000.50000000' },
          { documentType: 7, count: 1, amountPyg: '200000.00000000' },
          { documentType: 8, count: 1, amountPyg: '300000.25000000' },
        ],
        byStatus: [
          { status: 'rejected', count: 2, amountPyg: '0.00000000' },
          { status: 'approved', count: 4, amountPyg: '1650000.50000000' },
        ],
        rejectedTopCodes: [{ code: '1321', count: 2 }],
        previousCount: 9,
      }),
    );

    const summary = await run('t', {});

    expect(summary.totals).toEqual({ count: 6, amountPyg: '1650000.5', otherCurrencyCount: 1 });
    expect(summary.byType).toEqual([
      { type: 'FE', count: 3, amountPyg: '1100000' },
      { type: null, count: 2, amountPyg: '500000.25' },
      { type: 'NCE', count: 1, amountPyg: '50000.5' },
    ]);
    expect(summary.byStatus).toEqual([
      { status: 'approved', count: 4, amountPyg: '1650000.5' },
      { status: 'rejected', count: 2, amountPyg: '0' },
    ]);
    expect(summary.rejected).toEqual({ count: 2, topCodes: [{ code: '1321', count: 2 }] });
    expect(summary.previous).toEqual({ count: 9 });
  });

  it('reports the pending buckets and the oldest 72 h deadline', async () => {
    const { run } = setup(
      aggregates({
        pending: {
          count: 5,
          overdue: 1,
          dueSoon: 2,
          oldestSignedAt: new Date('2026-03-27T10:00:00Z'),
        },
      }),
    );

    expect((await run('t', {})).pending).toEqual({
      count: 5,
      overdue: 1,
      dueSoon: 2,
      oldestDeadline: '2026-03-30T10:00:00.000Z',
    });
  });

  it('has a null oldest deadline and zero rejections when nothing is pending or rejected', async () => {
    const summary = await setup().run('t', {});

    expect(summary.pending.oldestDeadline).toBeNull();
    expect(summary.rejected).toEqual({ count: 0, topCodes: [] });
  });

  it('rejects an invalid period without touching the source', async () => {
    const { run, summarize } = setup();

    await expect(run('t', { from: 'nope' })).rejects.toThrow(InvalidSummaryQueryError);
    expect(summarize).not.toHaveBeenCalled();
  });
});
