import { describe, expect, it } from 'vitest';
import { InvalidSummaryQueryError, asuncionToday, resolveSummaryPeriod } from './summary-period.js';

describe('asuncionToday (HU-E12-03)', () => {
  it('uses the Paraguay calendar day, not the UTC one', () => {
    // 2026-03-10 01:00Z is still 2026-03-09 22:00 in Asuncion (UTC-3 in March 2026).
    expect(asuncionToday(new Date('2026-03-10T01:00:00Z'))).toBe('2026-03-09');
  });
});

describe('resolveSummaryPeriod (HU-E12-03)', () => {
  const today = '2026-03-31';

  it('defaults to the last 30 calendar days ending today, inclusive', () => {
    expect(resolveSummaryPeriod({}, today)).toEqual({
      from: '2026-03-02',
      to: '2026-03-31',
      previousFrom: '2026-01-31',
      previousTo: '2026-03-01',
    });
  });

  it('builds the previous window of the same length right before from', () => {
    expect(resolveSummaryPeriod({ from: '2026-03-10', to: '2026-03-12' }, today)).toMatchObject({
      previousFrom: '2026-03-07',
      previousTo: '2026-03-09',
    });
  });

  it('defaults only the missing bound', () => {
    expect(resolveSummaryPeriod({ from: '2026-03-20' }, today)).toMatchObject({
      from: '2026-03-20',
      to: today,
    });
    expect(resolveSummaryPeriod({ to: '2026-03-05' }, today)).toMatchObject({
      from: '2026-02-04',
      to: '2026-03-05',
    });
  });

  it('accepts exactly 366 days and rejects 367', () => {
    expect(resolveSummaryPeriod({ from: '2025-03-31', to: '2026-03-31' }, today)).toMatchObject({
      from: '2025-03-31',
    });
    expect(() => resolveSummaryPeriod({ from: '2025-03-30', to: '2026-03-31' }, today)).toThrow(
      InvalidSummaryQueryError,
    );
  });

  it.each([
    [{ from: '2026-3-1' }],
    [{ to: '2026-02-30' }],
    [{ from: ['2026-03-01', '2026-03-02'] }],
    [{ from: '2026-03-10', to: '2026-03-09' }],
  ])('rejects %j', (raw) => {
    expect(() => resolveSummaryPeriod(raw, today)).toThrow(InvalidSummaryQueryError);
  });
});
