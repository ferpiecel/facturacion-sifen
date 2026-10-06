import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SealedSecret } from '../../custody/domain/sealed-secret.js';
import { hashRecoveryCode } from '../domain/recovery-codes.js';
import { totpAt } from '../domain/totp.js';
import {
  ConfirmMfaUseCase,
  EnrollMfaUseCase,
  MfaAlreadyEnrolledError,
  MfaResetForbiddenError,
  ResetMfaUseCase,
  VerifyMfaUseCase,
} from './mfa.use-cases.js';
import type {
  MfaAuditEvent,
  MfaAuditLog,
  MfaRecord,
  MfaSecretSealer,
  MfaStore,
  SessionRevoker,
} from './ports/mfa.ports.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

/** Seals by tagging with the user id: enough to prove the use cases bind the secret to the account. */
class FakeSealer implements MfaSecretSealer {
  seal(secret: Buffer, userId: string): Promise<SealedSecret> {
    return Promise.resolve({
      v: 1,
      keyId: userId,
      wrappedKey: '',
      nonce: '',
      tag: '',
      ciphertext: secret.toString('base64'),
    });
  }
  open(sealed: SealedSecret, userId: string): Promise<Buffer> {
    if (sealed.keyId !== userId) return Promise.reject(new Error('wrong user'));
    return Promise.resolve(Buffer.from(sealed.ciphertext, 'base64'));
  }
}

class MemoryStore implements MfaStore {
  readonly rows = new Map<string, MfaRecord>();
  find(userId: string) {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }
  savePending(userId: string, sealed: SealedSecret) {
    this.rows.set(userId, { sealed, confirmedAt: null, lastUsedStep: null, recoveryHashes: [] });
    return Promise.resolve();
  }
  confirm(userId: string, step: number, recoveryHashes: string[]) {
    const row = this.rows.get(userId);
    if (!row || row.confirmedAt) return Promise.resolve(false);
    this.rows.set(userId, {
      ...row,
      confirmedAt: new Date(NOW),
      lastUsedStep: step,
      recoveryHashes,
    });
    return Promise.resolve(true);
  }
  advanceStep(userId: string, step: number) {
    const row = this.rows.get(userId);
    if (!row || (row.lastUsedStep !== null && row.lastUsedStep >= step))
      return Promise.resolve(false);
    this.rows.set(userId, { ...row, lastUsedStep: step });
    return Promise.resolve(true);
  }
  consumeRecoveryCode(userId: string, hash: string) {
    const row = this.rows.get(userId);
    if (!row?.recoveryHashes.includes(hash)) return Promise.resolve(false);
    this.rows.set(userId, { ...row, recoveryHashes: row.recoveryHashes.filter((h) => h !== hash) });
    return Promise.resolve(true);
  }
  remove(userId: string) {
    this.rows.delete(userId);
    return Promise.resolve();
  }
}

function setup() {
  const store = new MemoryStore();
  const sealer = new FakeSealer();
  const events: MfaAuditEvent[] = [];
  const audit: MfaAuditLog = {
    record: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
  const revoked: string[] = [];
  const sessions: SessionRevoker = {
    revokeAllForUser: (id) => {
      revoked.push(id);
      return Promise.resolve();
    },
  };
  return { store, sealer, audit, events, sessions, revoked };
}

/** Enrols and confirms `userId`; returns the secret and the recovery codes. */
async function enrolled(userId = 'user-1') {
  const ctx = setup();
  const started = await new EnrollMfaUseCase(ctx.store, ctx.sealer, 'Acme').execute({
    userId,
    email: 'ana@example.com',
  });
  const secret = Buffer.from((await ctx.store.find(userId))?.sealed.ciphertext ?? '', 'base64');
  const confirmed = await new ConfirmMfaUseCase(ctx.store, ctx.sealer, ctx.audit).execute({
    userId,
    code: totpAt(secret, NOW),
    nowMs: NOW,
  });
  return { ...ctx, started, secret, recoveryCodes: confirmed?.recoveryCodes ?? [] };
}

describe('EnrollMfaUseCase', () => {
  it('stores a sealed pending secret and returns the otpauth URI and the base32 secret', async () => {
    const { store, sealer } = setup();
    const result = await new EnrollMfaUseCase(store, sealer, 'Acme').execute({
      userId: 'user-1',
      email: 'ana@example.com',
    });
    expect(result.otpauthUri).toMatch(
      /^otpauth:\/\/totp\/Acme:ana%40example\.com\?secret=[A-Z2-7]{32}&issuer=Acme/,
    );
    expect(result.secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect((await store.find('user-1'))?.confirmedAt).toBeNull();
  });

  it('replaces an unconfirmed enrolment but refuses a confirmed one', async () => {
    const { store, sealer, started } = await enrolled();
    await expect(
      new EnrollMfaUseCase(store, sealer, 'Acme').execute({
        userId: 'user-1',
        email: 'a@example.com',
      }),
    ).rejects.toBeInstanceOf(MfaAlreadyEnrolledError);
    expect(started.secretBase32).toBeDefined();
    const fresh = setup();
    const enroll = new EnrollMfaUseCase(fresh.store, fresh.sealer, 'Acme');
    const first = await enroll.execute({ userId: 'u', email: 'a@example.com' });
    const second = await enroll.execute({ userId: 'u', email: 'a@example.com' });
    expect(second.secretBase32).not.toBe(first.secretBase32);
  });
});

describe('ConfirmMfaUseCase', () => {
  it('activates MFA on a correct first code and issues ten recovery codes, stored only as hashes', async () => {
    const { store, recoveryCodes, events } = await enrolled();
    const row = await store.find('user-1');
    expect(recoveryCodes).toHaveLength(10);
    expect(row?.confirmedAt).not.toBeNull();
    expect(row?.recoveryHashes).toEqual(recoveryCodes.map(hashRecoveryCode));
    expect(JSON.stringify(row)).not.toContain(recoveryCodes[0]);
    expect(events).toEqual([
      { action: 'mfa.enrolled', actor: { type: 'user', id: 'user-1' }, targetUserId: 'user-1' },
    ]);
  });

  it('returns null and activates nothing on a wrong code or without a pending enrolment', async () => {
    const ctx = setup();
    const confirm = new ConfirmMfaUseCase(ctx.store, ctx.sealer, ctx.audit);
    await expect(
      confirm.execute({ userId: 'user-1', code: '000000', nowMs: NOW }),
    ).resolves.toBeNull();
    await new EnrollMfaUseCase(ctx.store, ctx.sealer, 'Acme').execute({
      userId: 'user-1',
      email: 'a@example.com',
    });
    await expect(
      confirm.execute({ userId: 'user-1', code: '000000', nowMs: NOW }),
    ).resolves.toBeNull();
    expect((await ctx.store.find('user-1'))?.confirmedAt).toBeNull();
    expect(ctx.events).toEqual([]);
  });
});

describe('VerifyMfaUseCase', () => {
  it('accepts a fresh TOTP once and refuses its replay', async () => {
    const { store, sealer, audit, secret } = await enrolled();
    const verify = new VerifyMfaUseCase(store, sealer, audit);
    const code = totpAt(secret, NOW + 30_000);
    await expect(verify.execute({ userId: 'user-1', code, nowMs: NOW + 30_000 })).resolves.toBe(
      true,
    );
    await expect(verify.execute({ userId: 'user-1', code, nowMs: NOW + 30_000 })).resolves.toBe(
      false,
    );
  });

  it('refuses the code used to confirm enrolment (its step is already spent)', async () => {
    const { store, sealer, audit, secret } = await enrolled();
    await expect(
      new VerifyMfaUseCase(store, sealer, audit).execute({
        userId: 'user-1',
        code: totpAt(secret, NOW),
        nowMs: NOW,
      }),
    ).resolves.toBe(false);
  });

  it('refuses a wrong code and a user without confirmed MFA', async () => {
    const { store, sealer, audit } = await enrolled();
    const verify = new VerifyMfaUseCase(store, sealer, audit);
    await expect(
      verify.execute({ userId: 'user-1', code: '000000', nowMs: NOW + 30_000 }),
    ).resolves.toBe(false);
    await expect(verify.execute({ userId: 'nobody', code: '123456', nowMs: NOW })).resolves.toBe(
      false,
    );
  });

  it('accepts each recovery code once, audited, in any spelling', async () => {
    const { store, sealer, audit, recoveryCodes, events } = await enrolled();
    const verify = new VerifyMfaUseCase(store, sealer, audit);
    const code = (recoveryCodes[2] as string).toUpperCase().replaceAll('-', ' ');
    await expect(verify.execute({ userId: 'user-1', code, nowMs: NOW })).resolves.toBe(true);
    await expect(verify.execute({ userId: 'user-1', code, nowMs: NOW })).resolves.toBe(false);
    expect((await store.find('user-1'))?.recoveryHashes).toHaveLength(9);
    expect(events.at(-1)).toMatchObject({
      action: 'mfa.recovery_code_used',
      targetUserId: 'user-1',
    });
  });

  it('does not open a secret sealed for another user', async () => {
    const { store, sealer, audit, secret } = await enrolled();
    const row = await store.find('user-1');
    store.rows.set('user-2', { ...(row as MfaRecord), lastUsedStep: null });
    const open = vi.spyOn(sealer, 'open');
    await expect(
      new VerifyMfaUseCase(store, sealer, audit).execute({
        userId: 'user-2',
        code: totpAt(secret, NOW),
        nowMs: NOW,
      }),
    ).resolves.toBe(false);
    expect(open).toHaveBeenCalled();
  });
});

describe('ResetMfaUseCase (PROVISIONAL rules: owner/admin reset others, only the operator resets an owner)', () => {
  const reset = (ctx: ReturnType<typeof setup>) =>
    new ResetMfaUseCase(ctx.store, ctx.sessions, ctx.audit);
  const target = (role: 'owner' | 'admin' | 'emisor' | 'lector') => ({ userId: 'user-1', role });

  it.each([
    [{ kind: 'user', userId: 'boss', role: 'owner' }, 'lector'],
    [{ kind: 'user', userId: 'boss', role: 'owner' }, 'admin'],
    [{ kind: 'user', userId: 'adm', role: 'admin' }, 'emisor'],
    [{ kind: 'operator' }, 'owner'],
  ] as const)(
    'lets %j reset a %s: removes MFA, revokes the sessions and audits',
    async (actor, role) => {
      const ctx = await enrolled();
      await reset(ctx).execute({ actor, target: target(role) });
      expect(await ctx.store.find('user-1')).toBeNull();
      expect(ctx.revoked).toEqual(['user-1']);
      expect(ctx.events.at(-1)).toMatchObject({
        action: 'mfa.reset',
        actor:
          actor.kind === 'operator'
            ? { type: 'operator', id: 'ops-cli' }
            : { type: 'user', id: actor.userId },
        targetUserId: 'user-1',
      });
    },
  );

  it.each([
    [{ kind: 'user', userId: 'adm', role: 'admin' }, 'owner'],
    [{ kind: 'user', userId: 'boss', role: 'owner' }, 'owner'],
    [{ kind: 'user', userId: 'em', role: 'emisor' }, 'lector'],
    [{ kind: 'user', userId: 'rd', role: 'lector' }, 'lector'],
    [{ kind: 'user', userId: 'user-1', role: 'owner' }, 'owner'],
  ] as const)('refuses %j resetting a %s, changing nothing', async (actor, role) => {
    const ctx = await enrolled();
    const events = ctx.events.length;
    await expect(reset(ctx).execute({ actor, target: target(role) })).rejects.toBeInstanceOf(
      MfaResetForbiddenError,
    );
    expect(await ctx.store.find('user-1')).not.toBeNull();
    expect(ctx.revoked).toEqual([]);
    expect(ctx.events).toHaveLength(events);
  });
});
