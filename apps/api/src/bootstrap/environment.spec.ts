import { describe, expect, it } from 'vitest';
import { parseSifenEnvironment } from './environment.js';

describe('parseSifenEnvironment', () => {
  it('defaults to "test" when SIFEN_ENVIRONMENT is not set', () => {
    expect(parseSifenEnvironment(undefined)).toBe('test');
  });

  it('accepts "test"', () => {
    expect(parseSifenEnvironment('test')).toBe('test');
  });

  it('accepts "production"', () => {
    expect(parseSifenEnvironment('production')).toBe('production');
  });

  it.each(['staging', 'Production', ''])('rejects invalid value %j', (value) => {
    expect(() => parseSifenEnvironment(value)).toThrow(/Invalid SIFEN_ENVIRONMENT/);
  });
});
