import { describe, expect, it, vi } from 'vitest';
import { hashSessionToken } from '../domain/session-token.js';
import type { SessionRecord, SessionStore } from './ports/session-store.port.js';
import { SessionService } from './session.service.js';

const CONFIG = { accessTtlSeconds: 300, refreshTtlSeconds: 600, absoluteTtlSeconds: 1_200 };
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const RECORD: SessionRecord = {
  sessionId: 's-1',
  userId: 'u-1',
  activeTenantId: null,
  mfaVerified: true,
  accessExpiresAt: new Date(NOW + 300_000),
  refreshExpiresAt: new Date(NOW + 600_000),
};

function setup(overrides: Partial<SessionStore> = {}) {
  const mocks = {
    create: vi.fn<SessionStore['create']>().mockResolvedValue('s-1'),
    resolve: vi.fn<SessionStore['resolve']>().mockResolvedValue(RECORD),
    rotate: vi.fn<SessionStore['rotate']>().mockResolvedValue(RECORD),
    revoke: vi.fn<SessionStore['revoke']>().mockResolvedValue(undefined),
    revokeAllForUser: vi.fn<SessionStore['revokeAllForUser']>().mockResolvedValue(2),
    listMemberships: vi
      .fn<SessionStore['listMemberships']>()
      .mockResolvedValue([{ tenantId: 't-a', tenantName: 'A', role: 'admin' }]),
    setActiveTenant: vi.fn<SessionStore['setActiveTenant']>().mockResolvedValue(true),
    promote: vi.fn<SessionStore['promote']>().mockResolvedValue('s-2'),
  };
  const store: SessionStore = { ...mocks, ...overrides };
  return { store: mocks, service: new SessionService(store, CONFIG, () => NOW) };
}

describe('SessionService authenticate (verified only) and authenticatePending', () => {
  const pendingRecord = { ...RECORD, mfaVerified: false };

  it('refuses a pending session on the default path, so a guard cannot let a password-only user in', async () => {
    const { service } = setup({ resolve: vi.fn().mockResolvedValue(pendingRecord) });
    await expect(service.authenticate('t')).resolves.toBeNull();
  });

  it('authenticatePending accepts only pending sessions', async () => {
    const pending = setup({ resolve: vi.fn().mockResolvedValue(pendingRecord) });
    await expect(pending.service.authenticatePending('t')).resolves.toEqual(pendingRecord);
    const verified = setup();
    await expect(verified.service.authenticatePending('t')).resolves.toBeNull();
    await expect(verified.service.authenticatePending('')).resolves.toBeNull();
  });

  it('promote swaps a pending session for a verified one built from fresh tokens and a new cap', async () => {
    const { service, store } = setup();
    const issued = await service.promote('s-1');
    expect(issued).toMatchObject({ sessionId: 's-2' });
    const call = store.promote.mock.calls[0];
    expect(call[0]).toBe('s-1');
    expect(call[1]).toMatchObject({ absoluteExpiresAt: new Date(NOW + 1_200_000) });
  });

  it('promote returns null when the pending session is no longer live', async () => {
    const { service } = setup({ promote: vi.fn().mockResolvedValue(null) });
    await expect(service.promote('s-1')).resolves.toBeNull();
  });
});

describe('SessionService', () => {
  it('issues an opaque pair, storing only the hashes and the absolute cap computed at login', async () => {
    const { service, store } = setup();
    const issued = await service.issue('u-1', { mfaVerified: false });
    expect(issued).toMatchObject({ sessionId: 's-1' });
    const call = store.create.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      userId: 'u-1',
      mfaVerified: false,
      accessHash: hashSessionToken(issued?.accessToken ?? ''),
      refreshHash: hashSessionToken(issued?.refreshToken ?? ''),
      accessExpiresAt: new Date(NOW + 300_000),
      refreshExpiresAt: new Date(NOW + 600_000),
      absoluteExpiresAt: new Date(NOW + 1_200_000),
    });
    expect(JSON.stringify(call)).not.toContain(issued?.accessToken);
  });

  it('issues nothing for a disabled or unknown user', async () => {
    const { service } = setup({ create: vi.fn().mockResolvedValue(null) });
    await expect(service.issue('u-1', { mfaVerified: true })).resolves.toBeNull();
  });

  it('authenticates by the hash of the access token and refuses an empty token', async () => {
    const { service, store } = setup();
    await expect(service.authenticate('some-token')).resolves.toEqual(RECORD);
    expect(store.resolve).toHaveBeenCalledWith(hashSessionToken('some-token'));
    await expect(service.authenticate('')).resolves.toBeNull();
  });

  it('refreshes into a new pair with sliding expiries (the store clamps them to the cap)', async () => {
    const { service, store } = setup();
    const next = await service.refresh('old-refresh');
    expect(next?.accessToken).not.toBe(next?.refreshToken);
    expect(store.rotate).toHaveBeenCalledWith(
      hashSessionToken('old-refresh'),
      hashSessionToken(next?.accessToken ?? ''),
      hashSessionToken(next?.refreshToken ?? ''),
      new Date(NOW + 300_000),
      new Date(NOW + 600_000),
    );
    expect(next).toMatchObject({
      sessionId: 's-1',
      accessExpiresAt: RECORD.accessExpiresAt,
      refreshExpiresAt: RECORD.refreshExpiresAt,
    });
  });

  it('returns null (the 401 path) when the store refuses the refresh', async () => {
    const { service } = setup({ rotate: vi.fn().mockResolvedValue(null) });
    await expect(service.refresh('stale')).resolves.toBeNull();
    await expect(service.refresh('')).resolves.toBeNull();
  });

  it('implements the SessionRevoker port, selects tenants and lists memberships', async () => {
    const { service, store } = setup();
    await service.revokeAllForUser('u-1');
    expect(store.revokeAllForUser).toHaveBeenCalledWith('u-1');
    await expect(service.selectTenant('s-1', 't-a')).resolves.toBe(true);
    await expect(service.memberships('u-1')).resolves.toEqual([
      { tenantId: 't-a', tenantName: 'A', role: 'admin' },
    ]);
    await service.logout('s-1');
    expect(store.revoke).toHaveBeenCalledWith('s-1');
  });
});
