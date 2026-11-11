import { describe, expect, it } from 'vitest';
import type { DeadlineWarning, DeadlineWarningStore } from './ports/deadline-warning-store.port.js';
import { WarnTransmissionDeadlines } from './warn-transmission-deadlines.js';

const NOW = new Date('2026-10-04T06:00:00.000Z');
const H = 3_600_000;

/** Spec: HU-E6-07. Which signing times each threshold asks the store for, and what it enqueues. */
describe('WarnTransmissionDeadlines', () => {
  function setup(pending: Record<number, { id: string; cdc: string; signedAt: Date }[]>) {
    const ranges: { hours: number; after: Date; until: Date }[] = [];
    const enqueued: { warnings: readonly DeadlineWarning[]; at: Date }[] = [];
    const store: DeadlineWarningStore = {
      findPending({ after, until }) {
        const hours = Math.round((NOW.getTime() - until.getTime()) / H);
        ranges.push({ hours, after, until });
        return Promise.resolve(pending[hours] ?? []);
      },
      enqueue(warnings, at) {
        enqueued.push({ warnings, at });
        return Promise.resolve();
      },
    };
    return {
      run: () => new WarnTransmissionDeadlines({ store, now: () => NOW }).run(),
      ranges,
      enqueued,
    };
  }

  it('asks, per threshold, for pending documents signed at least that long ago but within the 72 h window', async () => {
    const { run, ranges } = setup({});
    await run();
    expect(ranges.map((r) => r.hours)).toEqual([48, 66]);
    for (const range of ranges) {
      expect(range.after.toISOString()).toBe('2026-10-01T06:00:00.000Z');
    }
    expect(ranges[0].until.toISOString()).toBe('2026-10-02T06:00:00.000Z');
    expect(ranges[1].until.toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });

  it('enqueues one warning per document and threshold with its deadline and time left', async () => {
    const signedAt = new Date(NOW.getTime() - 66 * H);
    const { run, enqueued } = setup({ 66: [{ id: 'd1', cdc: 'c1', signedAt }] });
    expect(await run()).toEqual({ warned: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].at).toBe(NOW);
    expect(enqueued[0].warnings).toEqual([
      {
        documentId: 'd1',
        cdc: 'c1',
        thresholdHours: 66,
        deadline: new Date(signedAt.getTime() + 72 * H),
        hoursRemaining: 6,
      },
    ]);
  });

  it('does not enqueue when nothing crossed a threshold', async () => {
    const { run, enqueued } = setup({});
    expect(await run()).toEqual({ warned: 0 });
    expect(enqueued).toEqual([]);
  });
});
