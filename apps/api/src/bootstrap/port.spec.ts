import { describe, expect, it } from 'vitest';
import { parsePort } from './port.js';

describe('parsePort', () => {
  it('defaults to 3000 when PORT is not set', () => {
    expect(parsePort(undefined)).toBe(3000);
  });

  it('parses a valid numeric port', () => {
    expect(parsePort('8080')).toBe(8080);
  });

  it.each(['', 'abc', '0', '65536', '80.5', '-1'])('rejects invalid PORT value %j', (value) => {
    expect(() => parsePort(value)).toThrow(/Invalid PORT/);
  });
});
