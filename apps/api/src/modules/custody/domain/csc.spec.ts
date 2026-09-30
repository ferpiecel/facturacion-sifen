import { describe, expect, it } from 'vitest';
import { InvalidCscError, parseCsc } from './csc.js';

const VALUE = 'ABCD0000000000000000000000000000';

describe('parseCsc (HU-E2-03)', () => {
  it('accepts a 4-digit idCSC and a 32-character alphanumeric CSC', () => {
    expect(parseCsc('0001', VALUE)).toEqual({ idCsc: '0001', value: VALUE });
  });

  it.each(['1', '00012', 'ABCD', '000 ', ''])('rejects idCSC %j', (idCsc) => {
    expect(() => parseCsc(idCsc, VALUE)).toThrow(InvalidCscError);
  });

  it.each(['short', `${VALUE}0`, `${VALUE.slice(1)}-`, ` ${VALUE.slice(1)}`, ''])(
    'rejects CSC %j without echoing it',
    (value) => {
      expect(() => parseCsc('0001', value)).toThrow(InvalidCscError);
      try {
        parseCsc('0001', value);
      } catch (error) {
        expect((error as Error).message).not.toContain(value === '' ? '\u0000' : value);
      }
    },
  );
});
