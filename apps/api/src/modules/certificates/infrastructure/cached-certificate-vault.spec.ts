import { X509Certificate } from 'node:crypto';
import {
  auditLog,
  createPgliteDatabase,
  tenantFiscalProfiles,
  tenants,
  type Database,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestAuthority,
  issueTestPkcs12,
  type TestAuthority,
} from '../../../../test/support/test-pki.js';
import { revokeCertificate } from '../../../cli/commands.js';
import { EnvelopeCipher } from '../../custody/application/envelope-cipher.js';
import { createLocalKms } from '../../custody/infrastructure/adapters/local-kms.adapter.js';
import {
  CachedCertificateVault,
  DEFAULT_CERTIFICATE_CACHE_MAX_ENTRIES,
  DEFAULT_CERTIFICATE_CACHE_TTL_MS,
  type CertificateBackend,
} from './cached-certificate-vault.js';
import { CertificateNotFoundError, CertificateVault } from './certificate-vault.js';

const ACCESS = {
  actor: { type: 'system', id: 'transmission-worker' },
  purpose: 'signing',
} as const;
const DB = {} as Database;

/** Spec: HU-E3-02 (S3). LRU + TTL cache in front of the vault; audit only on decrypt. */
describe('CachedCertificateVault', () => {
  /** A backend that records what it returned, so zeroization of the cached copy is observable. */
  function backend(initial = 'fp-1') {
    const state = { fingerprint: initial as string | null, opens: 0, checks: 0 };
    const returned: Buffer[] = [];
    const vault: CertificateBackend = {
      open: () => {
        state.opens += 1;
        if (state.fingerprint === null) return Promise.reject(new CertificateNotFoundError('test'));
        const p12 = Buffer.from(`p12-of-${state.fingerprint}`);
        returned.push(p12);
        return Promise.resolve({ p12, password: 'pw', fingerprint: state.fingerprint });
      },
      currentFingerprint: () => {
        state.checks += 1;
        return Promise.resolve(state.fingerprint);
      },
    };
    return { vault, state, returned };
  }
  const isZero = (buffer: Buffer) => buffer.every((byte) => byte === 0);

  it('has short, bounded defaults: 5 minutes and 64 entries', () => {
    expect(DEFAULT_CERTIFICATE_CACHE_TTL_MS).toBe(300_000);
    expect(DEFAULT_CERTIFICATE_CACHE_MAX_ENTRIES).toBe(64);
  });

  it('decrypts once per TTL and hands out independent copies', async () => {
    const { vault, state } = backend();
    const cache = new CachedCertificateVault(vault);

    const first = await cache.open(DB, 't1', 'test', ACCESS);
    first.p12.fill(0); // SignDocument zeroizes what it receives
    const second = await cache.open(DB, 't1', 'test', ACCESS);

    expect(state.opens).toBe(1);
    expect(second.p12.toString()).toBe('p12-of-fp-1');
    expect(second.password).toBe('pw');
    expect(second.fingerprint).toBe('fp-1');
    expect(second.p12).not.toBe(first.p12);
  });

  it('keys by tenant and environment', async () => {
    const { vault, state } = backend();
    const cache = new CachedCertificateVault(vault);
    await cache.open(DB, 't1', 'test', ACCESS);
    await cache.open(DB, 't2', 'test', ACCESS);
    await cache.open(DB, 't1', 'production', ACCESS);
    expect(state.opens).toBe(3);
  });

  it('decrypts again after the TTL and zeroizes the expired entry', async () => {
    const { vault, state, returned } = backend();
    let now = 1_000;
    const cache = new CachedCertificateVault(vault, { ttlMs: 10_000, now: () => now });
    await cache.open(DB, 't1', 'test', ACCESS);
    now += 9_999;
    await cache.open(DB, 't1', 'test', ACCESS);
    expect(state.opens).toBe(1);
    now += 2;
    await cache.open(DB, 't1', 'test', ACCESS);
    expect(state.opens).toBe(2);
    expect(isZero(returned[0])).toBe(true);
    expect(isZero(returned[1])).toBe(false);
  });

  it('evicts the least recently used entry beyond its size and zeroizes it', async () => {
    const { vault, state, returned } = backend();
    const cache = new CachedCertificateVault(vault, { maxEntries: 2 });
    await cache.open(DB, 'a', 'test', ACCESS);
    await cache.open(DB, 'b', 'test', ACCESS);
    await cache.open(DB, 'a', 'test', ACCESS); // a is now the most recent
    await cache.open(DB, 'c', 'test', ACCESS); // evicts b

    expect(isZero(returned[1])).toBe(true);
    expect(isZero(returned[0])).toBe(false);
    expect(state.opens).toBe(3);
    await cache.open(DB, 'a', 'test', ACCESS);
    expect(state.opens).toBe(3);
    await cache.open(DB, 'b', 'test', ACCESS);
    expect(state.opens).toBe(4);
  });

  it('re-checks the stored status on every hit: a revoked or replaced certificate is dropped at once', async () => {
    const { vault, state, returned } = backend();
    const cache = new CachedCertificateVault(vault);
    await cache.open(DB, 't1', 'test', ACCESS);
    await cache.open(DB, 't1', 'test', ACCESS);
    expect(state.checks).toBe(1);

    state.fingerprint = 'fp-2'; // replaced by another certificate
    const replaced = await cache.open(DB, 't1', 'test', ACCESS);
    expect(replaced.fingerprint).toBe('fp-2');
    expect(isZero(returned[0])).toBe(true);

    state.fingerprint = null; // revoked
    await expect(cache.open(DB, 't1', 'test', ACCESS)).rejects.toThrow(CertificateNotFoundError);
    expect(isZero(returned[1])).toBe(true);
    state.fingerprint = 'fp-2';
    await cache.open(DB, 't1', 'test', ACCESS);
    expect(state.opens).toBe(4);
  });

  it('never caches a failed open and passes its error through', async () => {
    const { vault, state } = backend(null as unknown as string);
    state.fingerprint = null;
    const cache = new CachedCertificateVault(vault);
    await expect(cache.open(DB, 't1', 'test', ACCESS)).rejects.toThrow(CertificateNotFoundError);
    state.fingerprint = 'fp-1';
    expect((await cache.open(DB, 't1', 'test', ACCESS)).fingerprint).toBe('fp-1');
  });

  it('invalidate() and clear() zeroize what they drop', async () => {
    const { vault, returned } = backend();
    const cache = new CachedCertificateVault(vault);
    await cache.open(DB, 't1', 'test', ACCESS);
    await cache.open(DB, 't2', 'test', ACCESS);
    cache.invalidate('t1', 'test');
    expect(isZero(returned[0])).toBe(true);
    expect(isZero(returned[1])).toBe(false);
    cache.clear();
    expect(isZero(returned[1])).toBe(true);
  });

  describe('expiry does not depend on the same tenant coming back', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('sweeps every expired entry on any open, not only the one being asked for', async () => {
      const { vault, returned } = backend();
      let now = 1_000;
      const cache = new CachedCertificateVault(vault, { ttlMs: 10_000, now: () => now });
      await cache.open(DB, 'idle', 'test', ACCESS);
      now += 5_000;
      await cache.open(DB, 'busy', 'test', ACCESS);
      now += 6_000; // idle is past its TTL, busy is not
      await cache.open(DB, 'busy', 'test', ACCESS);

      expect(isZero(returned[0])).toBe(true);
      expect(isZero(returned[1])).toBe(false);
    });

    it('zeroizes an idle entry once the TTL passes even if nobody opens anything, then stops its timer', async () => {
      vi.useFakeTimers();
      const { vault, returned } = backend();
      const cache = new CachedCertificateVault(vault, { ttlMs: 10_000, sweepIntervalMs: 1_000 });
      await cache.open(DB, 't1', 'test', ACCESS);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(isZero(returned[0])).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(isZero(returned[0])).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clear() cancels the sweep timer', async () => {
      vi.useFakeTimers();
      const { vault } = backend();
      const cache = new CachedCertificateVault(vault, { sweepIntervalMs: 1_000 });
      await cache.open(DB, 't1', 'test', ACCESS);
      expect(vi.getTimerCount()).toBe(1);
      cache.clear();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('with the real vault', () => {
    let handle: DatabaseHandle | undefined;
    let psc: TestAuthority;
    beforeAll(() => {
      psc = createTestAuthority('Test PSC Root');
    });
    afterEach(async () => {
      await handle?.close();
      handle = undefined;
    });

    it('audits only decrypts and a revoke from another process blocks the next signing', async () => {
      handle = createPgliteDatabase();
      await handle.migrate();
      const { db } = handle;
      const [tenant] = await db.insert(tenants).values({ name: 'A' }).returning();
      await db.insert(tenantFiscalProfiles).values({
        tenantId: tenant.id,
        rucBase: '80000005',
        rucDv: 6,
        legalName: 'A S.A.',
        taxpayerType: 'persona_juridica',
      });
      const cipher = new EnvelopeCipher(createLocalKms(undefined, 'test', () => undefined));
      const real = new CertificateVault(cipher, {
        trustedPscRoots: [new X509Certificate(psc.pem)],
      });
      const stored = await real.add(db, {
        tenantId: tenant.id,
        environment: 'test',
        p12: issueTestPkcs12(psc, { serialNumber: 'RUC80000005-6' }, 'pw').p12,
        password: 'pw',
      });
      const cache = new CachedCertificateVault(real);

      await cache.open(db, tenant.id, 'test', ACCESS);
      await cache.open(db, tenant.id, 'test', ACCESS);
      await cache.open(db, tenant.id, 'test', ACCESS);
      const accessed = () =>
        db.select().from(auditLog).where(eq(auditLog.action, 'certificate.accessed'));
      expect(await accessed()).toHaveLength(1);

      await revokeCertificate(db, { tenantId: tenant.id, id: stored.id });
      await expect(cache.open(db, tenant.id, 'test', ACCESS)).rejects.toThrow(
        CertificateNotFoundError,
      );
      expect(await accessed()).toHaveLength(1);
    });
  });
});
