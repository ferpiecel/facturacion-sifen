import { describe, expect, it } from 'vitest';
import { SessionConfigError, loadSessionConfig } from './session-config.js';

const PRODUCTION = { accessTtlSeconds: 300, refreshTtlSeconds: 600, absoluteTtlSeconds: 43_200 };
const LOWER = { ...PRODUCTION, absoluteTtlSeconds: 1_200 };

describe('loadSessionConfig (PO decision: 5 min access, 10 min refresh, absolute cap)', () => {
  it('defaults to 12 h absolute in production', () => {
    expect(loadSessionConfig({ NODE_ENV: 'production' })).toEqual(PRODUCTION);
  });

  it.each(['development', 'test'])('defaults to a 20 min absolute cap in %s', (NODE_ENV) => {
    expect(loadSessionConfig({ NODE_ENV })).toEqual(LOWER);
  });

  it.each([undefined, '', 'staging', 'Production ', 'prod'])(
    'uses the production values when NODE_ENV is %j (the safe default)',
    (NODE_ENV) => {
      expect(loadSessionConfig({ NODE_ENV })).toEqual(PRODUCTION);
    },
  );

  it('lets each value be overridden by environment config', () => {
    expect(
      loadSessionConfig({
        NODE_ENV: 'production',
        SESSION_ACCESS_TTL_SECONDS: '120',
        SESSION_REFRESH_TTL_SECONDS: '900',
        SESSION_ABSOLUTE_TTL_SECONDS: '7200',
      }),
    ).toEqual({ accessTtlSeconds: 120, refreshTtlSeconds: 900, absoluteTtlSeconds: 7_200 });
  });

  it.each([
    ['SESSION_ACCESS_TTL_SECONDS', '5'],
    ['SESSION_ACCESS_TTL_SECONDS', '3601'],
    ['SESSION_REFRESH_TTL_SECONDS', '59'],
    ['SESSION_ABSOLUTE_TTL_SECONDS', '299'],
    ['SESSION_ABSOLUTE_TTL_SECONDS', '604801'],
    ['SESSION_ACCESS_TTL_SECONDS', 'abc'],
    ['SESSION_ACCESS_TTL_SECONDS', '12.5'],
  ])('fails fast on %s=%s without echoing the value', (name, value) => {
    const load = () => loadSessionConfig({ NODE_ENV: 'production', [name]: value });
    expect(load).toThrow(SessionConfigError);
    expect(load).toThrow(name);
    expect(load).not.toThrow(new RegExp(value.replace('.', '\\.') + '$'));
  });

  it('requires access <= refresh <= absolute', () => {
    expect(() =>
      loadSessionConfig({ NODE_ENV: 'production', SESSION_ACCESS_TTL_SECONDS: '900' }),
    ).toThrow(SessionConfigError);
    expect(() =>
      loadSessionConfig({ NODE_ENV: 'test', SESSION_REFRESH_TTL_SECONDS: '3000' }),
    ).toThrow(SessionConfigError);
  });
});
