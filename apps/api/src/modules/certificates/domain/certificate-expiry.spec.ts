import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_DAYS,
  dueAlertThreshold,
  isEmissionBlocked,
  parseAlertDays,
  parseBlockDays,
} from './certificate-expiry.js';

const DAY = 86_400_000;
const NOT_AFTER = new Date('2027-01-01T00:00:00.000Z');
const daysBefore = (days: number) => new Date(NOT_AFTER.getTime() - days * DAY);

/** Spec: HU-E3-03. Alerts at 60, 30 and 7 days; emission blocked from the day before expiry. */
describe('parseAlertDays', () => {
  it('defaults to 60, 30 and 7 when unset or blank', () => {
    expect(DEFAULT_ALERT_DAYS).toEqual([60, 30, 7]);
    expect(parseAlertDays(undefined)).toEqual([60, 30, 7]);
    expect(parseAlertDays('  ')).toEqual([60, 30, 7]);
  });

  it('parses a list, sorts it descending and drops duplicates', () => {
    expect(parseAlertDays('7, 90,30,30')).toEqual([90, 30, 7]);
  });

  it.each(['abc', '0', '-5', '1.5', '60,,30', '400'])('rejects %j', (raw) => {
    expect(() => parseAlertDays(raw)).toThrow(/CERTIFICATE_ALERT_DAYS/);
  });
});

describe('dueAlertThreshold', () => {
  const thresholds = [60, 30, 7];

  it('is undefined before the first threshold', () => {
    expect(dueAlertThreshold(NOT_AFTER, daysBefore(61), thresholds)).toBeUndefined();
  });

  it.each([
    [60, 60],
    [59, 60],
    [30, 30],
    [8, 30],
    [7, 7],
    [1, 7],
  ])('%d days left falls under the %d day threshold', (left, expected) => {
    expect(dueAlertThreshold(NOT_AFTER, daysBefore(left), thresholds)).toBe(expected);
  });

  it('is undefined once the certificate has expired', () => {
    expect(dueAlertThreshold(NOT_AFTER, NOT_AFTER, thresholds)).toBeUndefined();
    expect(dueAlertThreshold(NOT_AFTER, new Date(NOT_AFTER.getTime() + DAY), thresholds)).toBe(
      undefined,
    );
  });
});

describe('isEmissionBlocked', () => {
  it('allows emission until one day before expiry and refuses from then on', () => {
    expect(isEmissionBlocked(NOT_AFTER, new Date(daysBefore(1).getTime() - 1), 1)).toBe(false);
    expect(isEmissionBlocked(NOT_AFTER, daysBefore(1), 1)).toBe(true);
    expect(isEmissionBlocked(NOT_AFTER, NOT_AFTER, 1)).toBe(true);
    expect(isEmissionBlocked(NOT_AFTER, new Date(NOT_AFTER.getTime() + DAY), 1)).toBe(true);
  });

  it('honours a configured number of block days', () => {
    expect(isEmissionBlocked(NOT_AFTER, daysBefore(3), 3)).toBe(true);
    expect(isEmissionBlocked(NOT_AFTER, daysBefore(4), 3)).toBe(false);
  });
});

describe('parseBlockDays', () => {
  it('defaults to one day when unset or blank', () => {
    expect(parseBlockDays(undefined)).toBe(1);
    expect(parseBlockDays(' ')).toBe(1);
  });

  it('reads whole days from 0 (no preventive block) to 30', () => {
    expect(parseBlockDays('0')).toBe(0);
    expect(parseBlockDays('3')).toBe(3);
    expect(parseBlockDays('30')).toBe(30);
  });

  it.each(['abc', '-1', '1.5', '31'])('rejects %j', (raw) => {
    expect(() => parseBlockDays(raw)).toThrow(/CERTIFICATE_EMISSION_BLOCK_DAYS/);
  });
});
