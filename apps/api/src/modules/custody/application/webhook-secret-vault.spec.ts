import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretDecryptionError } from '../domain/sealed-secret.js';
import { EnvelopeCipher } from './envelope-cipher.js';
import type { DataKey, KeyManagementService } from './ports/key-management.port.js';
import { WebhookSecretVault } from './webhook-secret-vault.js';

const xor = (buffer: Buffer): Buffer => Buffer.from(buffer.map((byte) => byte ^ 0x5a));

class FakeKms implements KeyManagementService {
  generateDataKey(): Promise<DataKey> {
    const plaintextKey = randomBytes(32);
    return Promise.resolve({ plaintextKey, wrappedKey: xor(plaintextKey), keyId: 'fake:1' });
  }
  unwrapDataKey(wrappedKey: Buffer): Promise<Buffer> {
    return Promise.resolve(xor(wrappedKey));
  }
}

const vault = new WebhookSecretVault(new EnvelopeCipher(new FakeKms()));
const identity = { tenantId: 'tenant-a', endpointId: 'endpoint-1', version: 1 };
const now = new Date('2026-09-22T12:00:00Z');
const later = new Date('2026-09-23T12:00:00Z');
const earlier = new Date('2026-09-21T12:00:00Z');

/** Spec: HU-E11-01, ADR-0009. Signing secrets live sealed, bound to tenant, endpoint and version. */
describe('WebhookSecretVault', () => {
  const row = async (over: Partial<Parameters<WebhookSecretVault['signingSecrets']>[0]> = {}) => ({
    tenantId: 'tenant-a',
    endpointId: 'endpoint-1',
    secretVersion: 1,
    sealed: await vault.seal('whsec_current', identity),
    previousSealed: null,
    previousExpiresAt: null,
    now,
    ...over,
  });

  it('seals without leaving the secret in clear and opens it for signing', async () => {
    const input = await row();
    expect(JSON.stringify(input.sealed)).not.toContain('whsec_current');
    expect(await vault.signingSecrets(input)).toEqual(['whsec_current']);
  });

  it('signs with both secrets during a rotation overlap, the current one first', async () => {
    const input = await row({
      secretVersion: 2,
      sealed: await vault.seal('whsec_new', { ...identity, version: 2 }),
      previousSealed: await vault.seal('whsec_old', identity),
      previousExpiresAt: later,
    });
    expect(await vault.signingSecrets(input)).toEqual(['whsec_new', 'whsec_old']);
  });

  it('drops the previous secret once its overlap has expired', async () => {
    const input = await row({
      secretVersion: 2,
      sealed: await vault.seal('whsec_new', { ...identity, version: 2 }),
      previousSealed: await vault.seal('whsec_old', identity),
      previousExpiresAt: earlier,
    });
    expect(await vault.signingSecrets(input)).toEqual(['whsec_new']);
  });

  it.each([
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another endpoint', { endpointId: 'endpoint-2' }],
    ['another secret version', { secretVersion: 2 }],
  ])('refuses a blob presented under %s', async (_name, over) => {
    await expect(vault.signingSecrets(await row(over))).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it('binds the previous secret to the version before the current one', async () => {
    const input = await row({
      secretVersion: 3,
      sealed: await vault.seal('whsec_new', { ...identity, version: 3 }),
      previousSealed: await vault.seal('whsec_old', identity),
      previousExpiresAt: later,
    });
    await expect(vault.signingSecrets(input)).rejects.toBeInstanceOf(SecretDecryptionError);
  });
});
