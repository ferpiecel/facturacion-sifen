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

  it('fails closed: throws when NODE_ENV=production and SIFEN_ENVIRONMENT is unset', () => {
    expect(() => parseSifenEnvironment(undefined, 'production')).toThrow(
      /SIFEN_ENVIRONMENT must be set/,
    );
  });

  it('does not throw when NODE_ENV=production and SIFEN_ENVIRONMENT is explicitly set', () => {
    expect(parseSifenEnvironment('production', 'production')).toBe('production');
    expect(parseSifenEnvironment('test', 'production')).toBe('test');
  });

  it('still defaults to "test" when NODE_ENV is not production', () => {
    expect(parseSifenEnvironment(undefined, 'development')).toBe('test');
    expect(parseSifenEnvironment(undefined, undefined)).toBe('test');
  });
});
