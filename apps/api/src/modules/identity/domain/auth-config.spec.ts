import { describe, expect, it } from 'vitest';
import { AuthConfigError, loadAuthPepper } from './auth-config.js';

const SECRET = 'a'.repeat(32);

describe('loadAuthPepper (HMAC key for hashed throttle and audit subjects)', () => {
  it('reads AUTH_SUBJECT_PEPPER in production', () => {
    expect(loadAuthPepper({ NODE_ENV: 'production', AUTH_SUBJECT_PEPPER: SECRET }).toString()).toBe(
      SECRET,
    );
  });

  it.each([undefined, '', 'staging', 'prod'])(
    'fails fast without it when NODE_ENV is %j',
    (NODE_ENV) => {
      expect(() => loadAuthPepper({ NODE_ENV })).toThrow(AuthConfigError);
    },
  );

  it('rejects a short pepper without echoing it', () => {
    const load = () =>
      loadAuthPepper({ NODE_ENV: 'production', AUTH_SUBJECT_PEPPER: 'short-secret' });
    expect(load).toThrow(AuthConfigError);
    expect(load).not.toThrow(/short-secret/);
  });

  it.each(['development', 'test'])('uses a fixed development default only in %s', (NODE_ENV) => {
    expect(loadAuthPepper({ NODE_ENV }).length).toBeGreaterThanOrEqual(32);
    expect(loadAuthPepper({ NODE_ENV, AUTH_SUBJECT_PEPPER: SECRET }).toString()).toBe(SECRET);
  });
});
