import { describe, expect, it, vi } from 'vitest';
import { DUMMY_HASH } from './authenticate-api-key.use-case.js';
import { ACCOUNT_LIMIT, IP_LIMIT, LoginService, MFA_LIMIT } from './login.service.js';
import type { AuthEvent, AuthEventLog } from './ports/auth-event-log.port.js';
import type { LoginThrottle, ThrottleLimit } from './ports/login-throttle.port.js';
import type { SecretVerifier } from './ports/secret-verifier.port.js';
import type { IssuedSession } from './session.service.js';

const USER = { userId: 'u-1', passwordHash: 'real-hash', disabled: false };
const pending: IssuedSession = {
  sessionId: 'pending-1',
  accessToken: 'p-access',
  refreshToken: 'p-refresh',
  accessExpiresAt: new Date(0),
  refreshExpiresAt: new Date(0),
};
const full: IssuedSession = {
  ...pending,
  sessionId: 'full-1',
  accessToken: 'f-access',
  refreshToken: 'f-refresh',
};

function setup(
  opts: {
    user?: typeof USER | null;
    passwordOk?: boolean;
    confirmedMfa?: boolean;
    locked?: string[];
    mfaOk?: boolean;
  } = {},
) {
  const locked = new Set(opts.locked ?? []);
  const failures: [string, ThrottleLimit][] = [];
  const events: AuthEvent[] = [];
  const throttle: LoginThrottle = {
    isLocked: (s) => Promise.resolve(locked.has(s)),
    recordFailure: (s, l) => {
      failures.push([s, l]);
      return Promise.resolve(false);
    },
    clear: vi.fn<LoginThrottle['clear']>().mockResolvedValue(undefined),
  };
  const log: AuthEventLog = {
    record: (e) => {
      events.push(e);
      return Promise.resolve();
    },
  };
  const verify = vi.fn<SecretVerifier['verify']>().mockResolvedValue(opts.passwordOk ?? true);
  const sessions = {
    issue: vi
      .fn()
      .mockImplementation((_u: string, o: { mfaVerified: boolean }) =>
        Promise.resolve(o.mfaVerified ? full : pending),
      ),
    authenticate: vi
      .fn()
      .mockResolvedValue({
        sessionId: 'pending-1',
        userId: 'u-1',
        activeTenantId: null,
        mfaVerified: false,
      }),
    memberships: vi.fn().mockResolvedValue([{ tenantId: 't-a', tenantName: 'A', role: 'admin' }]),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  const mfa = {
    find: vi
      .fn()
      .mockResolvedValue(opts.confirmedMfa === false ? null : { confirmedAt: new Date() }),
    enroll: vi.fn().mockResolvedValue({ otpauthUri: 'otpauth://x', secretBase32: 'ABC' }),
    confirm: vi.fn().mockResolvedValue({ recoveryCodes: ['aaaa-bbbb-cccc-dddd'] }),
    verify: vi.fn().mockResolvedValue(opts.mfaOk ?? true),
  };
  const service = new LoginService({
    credentials: { findByEmail: () => Promise.resolve(opts.user === undefined ? USER : opts.user) },
    verifier: { verify },
    throttle,
    events: log,
    sessions: sessions as never,
    mfaStore: { find: mfa.find } as never,
    enroll: { execute: mfa.enroll } as never,
    confirm: { execute: mfa.confirm } as never,
    verifyMfa: { execute: mfa.verify } as never,
    now: () => 1_000,
  });
  return { service, verify, throttle, failures, events, sessions, mfa };
}

describe('LoginService.start (password step)', () => {
  it('opens a PENDING session and asks for the second factor when MFA is enrolled', async () => {
    const { service, sessions, events } = setup();
    const result = await service.start({
      email: ' Ana@Example.com ',
      password: 'pw',
      ip: '203.0.113.9',
    });
    expect(result).toEqual({ status: 'mfa_required', session: pending });
    expect(sessions.issue).toHaveBeenCalledWith('u-1', { mfaVerified: false });
    expect(events.map((e) => e.event)).toEqual(['login.password_ok']);
  });

  it('forces enrolment first for a user without confirmed MFA (provisional: MFA is mandatory)', async () => {
    const { service } = setup({ confirmedMfa: false });
    expect(await service.start({ email: 'a@example.com', password: 'pw' })).toEqual({
      status: 'mfa_enrollment_required',
      session: pending,
    });
  });

  it('answers the same generic result for an unknown email, a wrong password and a disabled user', async () => {
    for (const opts of [
      { user: null },
      { passwordOk: false },
      { user: { ...USER, disabled: true }, passwordOk: true },
    ]) {
      const { service, sessions } = setup(opts);
      const result = await service.start({ email: 'a@example.com', password: 'pw' });
      expect(result).toEqual({ status: 'invalid' });
      expect(sessions.issue).not.toHaveBeenCalled();
    }
  });

  it('counts a failure against the account and the IP, with the documented limits, and audits it', async () => {
    const { service, failures, events } = setup({ passwordOk: false });
    await service.start({ email: 'Ana@Example.com', password: 'bad', ip: '203.0.113.9' });
    expect(failures).toEqual([
      ['account:ana@example.com', ACCOUNT_LIMIT],
      ['ip:203.0.113.9', IP_LIMIT],
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        event: 'login.password_failed',
        userId: null,
        subject: 'account:ana@example.com',
      }),
    ]);
    expect(ACCOUNT_LIMIT).toEqual({ max: 5, windowSeconds: 900, lockSeconds: 900 });
    expect(IP_LIMIT.max).toBe(20);
  });

  it.each([['account:ana@example.com'], ['ip:203.0.113.9']])(
    'refuses while %s is locked, still spending one verification, even with the right password',
    async (subject) => {
      const { service, verify, sessions, events } = setup({ locked: [subject] });
      expect(
        await service.start({ email: 'ana@example.com', password: 'right', ip: '203.0.113.9' }),
      ).toEqual({ status: 'invalid' });
      expect(verify).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledWith('right', DUMMY_HASH);
      expect(sessions.issue).not.toHaveBeenCalled();
      expect(events.map((e) => e.event)).toEqual(['login.locked']);
    },
  );

  it('clears the account counter after a good password but never the IP one', async () => {
    const { service, throttle } = setup();
    await service.start({ email: 'ana@example.com', password: 'pw', ip: '203.0.113.9' });
    expect(throttle.clear).toHaveBeenCalledExactlyOnceWith('account:ana@example.com');
  });

  it('never records the password in an event', async () => {
    const { service, events } = setup({ passwordOk: false });
    await service.start({ email: 'a@example.com', password: 'sup3r-secret-pw' });
    expect(JSON.stringify(events)).not.toContain('sup3r-secret-pw');
  });
});

describe('LoginService MFA steps', () => {
  it('verifies the code and swaps the pending session for a fresh verified one (no fixation)', async () => {
    const { service, sessions, events, throttle } = setup();
    expect(await service.verifyMfa({ pendingToken: 'p-access', code: '123456' })).toEqual({
      session: full,
      tenants: [{ tenantId: 't-a', tenantName: 'A', role: 'admin' }],
    });
    expect(sessions.issue).toHaveBeenCalledWith('u-1', { mfaVerified: true });
    expect(sessions.logout).toHaveBeenCalledWith('pending-1');
    expect(events.map((e) => e.event)).toEqual(['login.succeeded']);
    expect(throttle.clear).toHaveBeenCalledWith('mfa:u-1');
  });

  it('refuses a wrong code, counts it against the user and audits it, leaving the pending session', async () => {
    const { service, failures, events, sessions } = setup({ mfaOk: false });
    expect(await service.verifyMfa({ pendingToken: 'p-access', code: '000000' })).toBeNull();
    expect(failures).toEqual([['mfa:u-1', MFA_LIMIT]]);
    expect(events.map((e) => e.event)).toEqual(['login.mfa_failed']);
    expect(sessions.logout).not.toHaveBeenCalled();
  });

  it('refuses while the user is locked out of the second factor, without checking the code', async () => {
    const { service, mfa } = setup({ locked: ['mfa:u-1'] });
    expect(await service.verifyMfa({ pendingToken: 'p-access', code: '123456' })).toBeNull();
    expect(mfa.verify).not.toHaveBeenCalled();
  });

  it('accepts only a pending session: no token, an unknown token or an already verified one', async () => {
    const { service, sessions } = setup();
    sessions.authenticate.mockResolvedValueOnce(null);
    expect(await service.verifyMfa({ pendingToken: 'nope', code: '123456' })).toBeNull();
    sessions.authenticate.mockResolvedValueOnce({
      sessionId: 's',
      userId: 'u-1',
      activeTenantId: null,
      mfaVerified: true,
    });
    expect(await service.verifyMfa({ pendingToken: 'full', code: '123456' })).toBeNull();
  });

  it('enrols from the pending session and, once the first code is confirmed, returns recovery codes and a verified session', async () => {
    const { service, mfa, sessions } = setup({ confirmedMfa: false });
    expect(
      await service.beginEnrollment({ pendingToken: 'p-access', account: 'ana@example.com' }),
    ).toEqual({ otpauthUri: 'otpauth://x', secretBase32: 'ABC' });
    expect(mfa.enroll).toHaveBeenCalledWith({ userId: 'u-1', email: 'ana@example.com' });
    const done = await service.completeEnrollment({ pendingToken: 'p-access', code: '123456' });
    expect(done).toMatchObject({ recoveryCodes: ['aaaa-bbbb-cccc-dddd'], session: full });
    expect(mfa.confirm).toHaveBeenCalledWith({
      userId: 'u-1',
      code: '123456',
      tenantIds: ['t-a'],
      nowMs: 1_000,
    });
    expect(sessions.logout).toHaveBeenCalledWith('pending-1');
  });

  it('does not confirm enrolment with a wrong code', async () => {
    const { service, mfa } = setup({ confirmedMfa: false });
    mfa.confirm.mockResolvedValueOnce(null);
    expect(
      await service.completeEnrollment({ pendingToken: 'p-access', code: '000000' }),
    ).toBeNull();
  });
});
