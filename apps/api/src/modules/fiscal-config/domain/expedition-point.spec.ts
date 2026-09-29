import { describe, expect, it } from 'vitest';
import { createExpeditionPoint, InvalidExpeditionPointError } from './expedition-point.js';

describe('createExpeditionPoint', () => {
  it('builds an expedition point from a valid 3-digit code', () => {
    expect(createExpeditionPoint({ code: '001' })).toEqual({ code: '001' });
  });

  it('trims the code', () => {
    expect(createExpeditionPoint({ code: ' 002 ' })).toEqual({ code: '002' });
  });

  it('rejects a code shorter than 3 digits', () => {
    expect(() => createExpeditionPoint({ code: '1' })).toThrow(InvalidExpeditionPointError);
  });

  it('rejects a code longer than 3 digits', () => {
    expect(() => createExpeditionPoint({ code: '1234' })).toThrow(InvalidExpeditionPointError);
  });

  it('rejects code "000" (dPunExp, MT §C006: 001-999)', () => {
    expect(() => createExpeditionPoint({ code: '000' })).toThrow(InvalidExpeditionPointError);
  });

  it('rejects a non-numeric code', () => {
    expect(() => createExpeditionPoint({ code: 'AAA' })).toThrow(InvalidExpeditionPointError);
  });
});
