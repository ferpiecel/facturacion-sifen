import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretDecryptionError } from '../domain/sealed-secret.js';
import { EnvelopeCipher } from './envelope-cipher.js';
import type { DataKey, KeyManagementService } from './ports/key-management.port.js';
import { MfaSecretVault } from './mfa-secret-vault.js';

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

const vault = new MfaSecretVault(new EnvelopeCipher(new FakeKms()));

describe('MfaSecretVault (ADR-0009 envelope encryption of the TOTP secret)', () => {
  it('seals a secret that opens back for the same user', async () => {
    const secret = randomBytes(20);
    const sealed = await vault.seal(secret, 'user-1');
    expect(JSON.stringify(sealed)).not.toContain(secret.toString('base64'));
    expect((await vault.open(sealed, 'user-1')).equals(secret)).toBe(true);
  });

  it('refuses to open a secret sealed for another user', async () => {
    const sealed = await vault.seal(randomBytes(20), 'user-1');
    await expect(vault.open(sealed, 'user-2')).rejects.toBeInstanceOf(SecretDecryptionError);
  });
});
