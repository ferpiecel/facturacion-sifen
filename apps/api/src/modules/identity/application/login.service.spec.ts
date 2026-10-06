import { describe, expect, it, vi } from 'vitest';
import { hashSessionToken } from '../domain/session-token.js';
import { DUMMY_HASH } from './authenticate-api-key.use-case.js';
import {
  ACCOUNT_LIMIT,
  IP_LIMIT,
  LoginService,
  MFA_CONSECUTIVE_FAILURE_CAP,
  MFA_LIMIT,
} from './login.service.js';
import type { AuthEvent, AuthEventLog } from './ports/auth-event-log.port.js';
import type { LoginThrottle, ThrottleLimit } from './ports/login-throttle.port.js';
import type { MfaAttemptGuard } from './ports/mfa-attempt-guard.port.js';
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

interface Options {
  user?: typeof USER | null;
  passwordOk?: boolean;
  confirmedMfa?: boolean;
  locked?: string[];
  mfaOk?: boolean;
  promoted?: IssuedSession | null;
  /** The per-window throttle never refuses (isolates the consecutive cap). */
  windowOpen?: boolean;
  capReached?: boolean;
}

function setup(opts: Options = {}) {
  const locked = new Set(opts.locked ?? []);
  const counts = new Map<string, number>();
  const reservations: [string, ThrottleLimit][] = [];
  const order: string[] = [];
  const events: AuthEvent[] = [];
  /** Synchronous counter, like the SQL upsert: atomic per call, so concurrency in the tests is meaningful. */
  const reserve = vi.fn<LoginThrottle['reserve']>().mockImplementation((subject, limit) => {
    order.push(`reserve:${subject}`);
    reservations.push([subject, limit]);
    const n = (counts.get(subject) ?? 0) + 1;
    counts.set(subject, n);
    if (opts.windowOpen && subject.startsWith('mfa:')) return Promise.resolve(true);
    return Promise.resolve(!locked.has(subject) && n <= limit.max);
  });
  const clear = vi.fn<LoginThrottle['clear']>().mockResolvedValue(undefined);
  const throttle: LoginThrottle = { reserve, clear };
  const log: AuthEventLog = {
    record: (e) => {
      events.push(e);
      return Promise.resolve();
    },
  };
  const verify = vi.fn<SecretVerifier['verify']>().mockImplementation(() => {
    order.push('verify');
    return Promise.resolve(opts.passwordOk ?? true);
  });
  const sessions = {
    issue: vi.fn().mockResolvedValue(pending),
    authenticatePending: vi.fn().mockResolvedValue({
      sessionId: 'pending-1',
      userId: 'u-1',
      activeTenantId: null,
      mfaVerified: false,
    }),
    promote: vi.fn().mockResolvedValue(opts.promoted === undefined ? full : opts.promoted),
    memberships: vi.fn().mockResolvedValue([{ tenantId: 't-a', tenantName: 'A', role: 'admin' }]),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  let attempts = 0;
  const guardReserve = vi.fn<MfaAttemptGuard['reserve']>().mockImplementation(() => {
    order.push('guard');
    attempts += 1;
    return Promise.resolve(opts.capReached !== true && attempts <= MFA_CONSECUTIVE_FAILURE_CAP);
  });
  const guardSucceeded = vi.fn<MfaAttemptGuard['succeeded']>().mockResolvedValue(undefined);
  const mfaVerify = vi.fn().mockImplementation(() => {
    order.push('mfa');
    return Promise.resolve(opts.mfaOk ?? true);
  });
  const mfa = {
    find: vi
      .fn()
      .mockResolvedValue(opts.confirmedMfa === false ? null : { confirmedAt: new Date() }),
    enroll: vi.fn().mockResolvedValue({ otpauthUri: 'otpauth://x', secretBase32: 'ABC' }),
    confirm: vi.fn().mockResolvedValue({ recoveryCodes: ['aaaa-bbbb-cccc-dddd'] }),
    verify: mfaVerify,
  };
  const mfaFor = vi.fn().mockImplementation(() => ({
    store: { find: mfa.find },
    enroll: { execute: mfa.enroll },
    confirm: { execute: mfa.confirm },
    verify: { execute: mfa.verify },
    guard: { reserve: guardReserve, succeeded: guardSucceeded },
  }));
  const service = new LoginService({
    credentials: { findByEmail: () => Promise.resolve(opts.user === undefined ? USER : opts.user) },
    verifier: { verify },
    throttle,
    events: log,
    sessions: sessions as never,
    mfa: mfaFor as never,
    now: () => 1_000,
  });
  return {
    service,
    verify,
    clear,
    reservations,
    order,
    events,
    sessions,
    mfa,
    guardReserve,
    guardSucceeded,
  };
}

describe('MFA state is reachable only through the pending session (no caller-chosen user id)', () => {
  it('builds the MFA capabilities from the hash of the pending token, at every step', async () => {
    const { service, mfaFor } = setup();
    await service.verifyMfa({ pendingToken: 'p-access', code: '123456' });
    expect(mfaFor).toHaveBeenCalledWith(hashSessionToken('p-access'));
    const login = setup();
    await login.service.start({ email: 'a@example.com', password: 'pw' });
    expect(login.mfaFor).toHaveBeenCalledWith(hashSessionToken('p-access'));
  });

  it('asks the guard without a user id: it is bound to the pending session', async () => {
    const { service, guardReserve, guardSucceeded } = setup();
    await service.verifyMfa({ pendingToken: 'p-access', code: '123456' });
    expect(guardReserve).toHaveBeenCalledWith();
    expect(guardSucceeded).toHaveBeenCalledWith();
  });

  it('audits a user without MFA server-side, so the response need not tell the caller', async () => {
    const { service, events } = setup({ confirmedMfa: false });
    await service.start({ email: 'a@example.com', password: 'pw' });
    expect(events.map((e) => e.event)).toEqual([
      'login.password_ok',
      'login.mfa_enrollment_required',
    ]);
  });
});

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
      expect(await service.start({ email: 'a@example.com', password: 'pw' })).toEqual({
        status: 'invalid',
      });
      expect(sessions.issue).not.toHaveBeenCalled();
    }
  });

  it('RESERVES the attempt on the account and the IP before verifying the password', async () => {
    const { service, reservations, order, events } = setup({ passwordOk: false });
    await service.start({ email: 'Ana@Example.com', password: 'bad', ip: '203.0.113.9' });
    expect(reservations).toEqual([
      ['account:ana@example.com', ACCOUNT_LIMIT],
      ['ip:203.0.113.9', IP_LIMIT],
    ]);
    expect(order.indexOf('verify')).toBeGreaterThan(order.indexOf('reserve:ip:203.0.113.9'));
    expect(events).toEqual([
      expect.objectContaining({ event: 'login.password_failed', userId: null }),
    ]);
    expect(ACCOUNT_LIMIT).toEqual({ max: 5, windowSeconds: 900, lockSeconds: 900 });
    expect(IP_LIMIT.max).toBe(60);
  });

  it('lets at most ACCOUNT_LIMIT.max of a concurrent burst reach the real password check', async () => {
    const { service, verify } = setup({ passwordOk: false });
    await Promise.all(
      Array.from({ length: 40 }, () =>
        service.start({ email: 'ana@example.com', password: 'bad' }),
      ),
    );
    const real = verify.mock.calls.filter(([, hash]) => hash === 'real-hash');
    expect(real).toHaveLength(ACCOUNT_LIMIT.max);
  });

  it.each([['account:ana@example.com'], ['ip:203.0.113.9']])(
    'refuses while %s is locked, still spending one dummy verification, even with the right password',
    async (subject) => {
      const { service, verify, sessions, events } = setup({ locked: [subject] });
      expect(
        await service.start({ email: 'ana@example.com', password: 'right', ip: '203.0.113.9' }),
      ).toEqual({
        status: 'invalid',
      });
      expect(verify).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledWith('right', DUMMY_HASH);
      expect(sessions.issue).not.toHaveBeenCalled();
      expect(events.map((e) => e.event)).toEqual(['login.locked']);
    },
  );

  it('clears the account counter after a good password but never the IP one', async () => {
    const { service, clear } = setup();
    await service.start({ email: 'ana@example.com', password: 'pw', ip: '203.0.113.9' });
    expect(clear).toHaveBeenCalledExactlyOnceWith('account:ana@example.com');
  });

  it('never records the password in an event', async () => {
    const { service, events } = setup({ passwordOk: false });
    await service.start({ email: 'a@example.com', password: 'sup3r-secret-pw' });
    expect(JSON.stringify(events)).not.toContain('sup3r-secret-pw');
  });
});

describe('LoginService MFA steps', () => {
  it('verifies the code and PROMOTES the pending session to a fresh verified one (no fixation)', async () => {
    const { service, sessions, events, clear } = setup();
    expect(await service.verifyMfa({ pendingToken: 'p-access', code: '123456' })).toEqual({
      session: full,
      tenants: [{ tenantId: 't-a', tenantName: 'A', role: 'admin' }],
    });
    expect(sessions.promote).toHaveBeenCalledWith('pending-1');
    expect(events.map((e) => e.event)).toEqual(['login.succeeded']);
    expect(clear).toHaveBeenCalledWith('mfa:u-1');
  });

  it('reserves the MFA attempt BEFORE checking the code', async () => {
    const { service, reservations, order } = setup();
    await service.verifyMfa({ pendingToken: 'p-access', code: '123456' });
    expect(reservations).toEqual([['mfa:u-1', MFA_LIMIT]]);
    expect(order).toEqual(['reserve:mfa:u-1', 'guard', 'mfa']);
  });

  it('lets at most MFA_LIMIT.max of a concurrent burst of codes be checked', async () => {
    const { service, mfa } = setup({ mfaOk: false });
    await Promise.all(
      Array.from({ length: 5000 }, (_, i) =>
        service.verifyMfa({ pendingToken: 'p-access', code: String(i).padStart(6, '0') }),
      ),
    );
    expect(mfa.verify).toHaveBeenCalledTimes(MFA_LIMIT.max);
  });

  describe('consecutive failure cap (per user, only a success resets it)', () => {
    it('lets at most the cap of failures through across any number of windows', async () => {
      const { service, mfa } = setup({ mfaOk: false, windowOpen: true });
      await Promise.all(
        Array.from({ length: 300 }, (_, i) =>
          service.verifyMfa({ pendingToken: 'p-access', code: String(i).padStart(6, '0') }),
        ),
      );
      expect(mfa.verify).toHaveBeenCalledTimes(MFA_CONSECUTIVE_FAILURE_CAP);
    });

    it('revokes the pending session, audits the cap and never checks the code once it is reached', async () => {
      const { service, mfa, sessions, events } = setup({ capReached: true });
      expect(await service.verifyMfa({ pendingToken: 'p-access', code: '123456' })).toBeNull();
      expect(mfa.verify).not.toHaveBeenCalled();
      expect(sessions.logout).toHaveBeenCalledWith('pending-1');
      expect(events.map((e) => e.event)).toEqual(['login.mfa_cap_reached']);
    });

    it('reports a success so the count resets, and only then', async () => {
      const ok = setup();
      await ok.service.verifyMfa({ pendingToken: 'p-access', code: '123456' });
      expect(ok.guardSucceeded).toHaveBeenCalledOnce();
      const bad = setup({ mfaOk: false });
      await bad.service.verifyMfa({ pendingToken: 'p-access', code: '000000' });
      expect(bad.guardSucceeded).not.toHaveBeenCalled();
    });

    it('applies to the enrolment confirmation code too', async () => {
      const { service, mfa } = setup({ confirmedMfa: false, capReached: true });
      expect(
        await service.completeEnrollment({ pendingToken: 'p-access', code: '123456' }),
      ).toBeNull();
      expect(mfa.confirm).not.toHaveBeenCalled();
    });
  });

  it('revokes the pending session when the lock trips and never checks the code', async () => {
    const { service, mfa, sessions } = setup({ locked: ['mfa:u-1'] });
    expect(await service.verifyMfa({ pendingToken: 'p-access', code: '123456' })).toBeNull();
    expect(mfa.verify).not.toHaveBeenCalled();
    expect(sessions.logout).toHaveBeenCalledWith('pending-1');
  });

  it('refuses a wrong code and audits it, leaving the pending session until the lock trips', async () => {
    const { service, events, sessions } = setup({ mfaOk: false });
    expect(await service.verifyMfa({ pendingToken: 'p-access', code: '000000' })).toBeNull();
    expect(events.map((e) => e.event)).toEqual(['login.mfa_failed']);
    expect(sessions.promote).not.toHaveBeenCalled();
    expect(sessions.logout).not.toHaveBeenCalled();
  });

  it('issues no session when the pending one was revoked after the code was accepted', async () => {
    const { service, events } = setup({ promoted: null });
    expect(await service.verifyMfa({ pendingToken: 'p-access', code: '123456' })).toBeNull();
    expect(events.map((e) => e.event)).not.toContain('login.succeeded');
  });

  it('accepts only a pending session: no token, an unknown token or an already verified one', async () => {
    const { service, sessions } = setup();
    sessions.authenticatePending.mockResolvedValueOnce(null);
    expect(await service.verifyMfa({ pendingToken: 'nope', code: '123456' })).toBeNull();
    expect(sessions.authenticatePending).toHaveBeenCalledWith('nope');
  });

  it('enrols from the pending session and, once the first code is confirmed, returns recovery codes and a verified session', async () => {
    const { service, mfa, sessions } = setup({ confirmedMfa: false });
    expect(
      await service.beginEnrollment({ pendingToken: 'p-access', account: 'ana@example.com' }),
    ).toEqual({
      otpauthUri: 'otpauth://x',
      secretBase32: 'ABC',
    });
    expect(mfa.enroll).toHaveBeenCalledWith({ userId: 'u-1', email: 'ana@example.com' });
    const done = await service.completeEnrollment({ pendingToken: 'p-access', code: '123456' });
    expect(done).toMatchObject({ recoveryCodes: ['aaaa-bbbb-cccc-dddd'], session: full });
    expect(mfa.confirm).toHaveBeenCalledWith({
      userId: 'u-1',
      code: '123456',
      tenantIds: ['t-a'],
      nowMs: 1_000,
    });
    expect(sessions.promote).toHaveBeenCalledWith('pending-1');
  });

  it('does not confirm enrolment with a wrong code', async () => {
    const { service, mfa } = setup({ confirmedMfa: false });
    mfa.confirm.mockResolvedValueOnce(null);
    expect(
      await service.completeEnrollment({ pendingToken: 'p-access', code: '000000' }),
    ).toBeNull();
  });

  it('throttles the confirmation code like the second factor', async () => {
    const { service, mfa, sessions } = setup({ confirmedMfa: false, locked: ['mfa:u-1'] });
    expect(
      await service.completeEnrollment({ pendingToken: 'p-access', code: '123456' }),
    ).toBeNull();
    expect(mfa.confirm).not.toHaveBeenCalled();
    expect(sessions.logout).toHaveBeenCalledWith('pending-1');
  });
});
