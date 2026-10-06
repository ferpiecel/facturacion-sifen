import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SecretDecryptionError,
  type SealedSecret,
  type SecretContext,
} from '../domain/sealed-secret.js';
import { EnvelopeCipher } from './envelope-cipher.js';
import {
  KeyServiceUnavailableError,
  KeyUnwrapError,
  type DataKey,
  type KeyManagementService,
} from './ports/key-management.port.js';

/** Test double: "wraps" by XOR so a tampered wrapped key unwraps to a wrong key. */
class FakeKms implements KeyManagementService {
  readonly issued: Buffer[] = [];

  generateDataKey(): Promise<DataKey> {
    const plaintextKey = randomBytes(32);
    this.issued.push(plaintextKey);
    return Promise.resolve({ plaintextKey, wrappedKey: xor(plaintextKey), keyId: 'fake:1' });
  }

  unwrapDataKey(wrappedKey: Buffer, keyId: string): Promise<Buffer> {
    if (keyId !== 'fake:1') return Promise.reject(new KeyUnwrapError());
    return Promise.resolve(xor(wrappedKey));
  }
}

function xor(buffer: Buffer): Buffer {
  return Buffer.from(buffer.map((byte) => byte ^ 0x5a));
}

const CONTEXT: SecretContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  kind: 'csc',
  environment: 'test',
  version: 1,
};
const SECRET = 'ABCD0000000000000000000000000000';

function flipFirstByte(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);
  return bytes.toString('base64');
}

async function seal(): Promise<{ cipher: EnvelopeCipher; sealed: SealedSecret; kms: FakeKms }> {
  const kms = new FakeKms();
  const cipher = new EnvelopeCipher(kms);
  const sealed = await cipher.seal(Buffer.from(SECRET, 'utf8'), CONTEXT);
  return { cipher, sealed, kms };
}

describe('EnvelopeCipher', () => {
  it('round-trips a secret under the same context', async () => {
    const { cipher, sealed } = await seal();

    const opened = await cipher.open(sealed, CONTEXT);

    expect(opened.toString('utf8')).toBe(SECRET);
    expect(sealed).toMatchObject({ v: 1, keyId: 'fake:1' });
  });

  it('never stores the plaintext and uses a 96-bit nonce and 128-bit tag', async () => {
    const { sealed } = await seal();

    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(Buffer.from(sealed.nonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(sealed.tag, 'base64')).toHaveLength(16);
  });

  it('uses a fresh data key and a fresh nonce for every encryption', async () => {
    const kms = new FakeKms();
    const cipher = new EnvelopeCipher(kms);

    const first = await cipher.seal(Buffer.from(SECRET), CONTEXT);
    const second = await cipher.seal(Buffer.from(SECRET), CONTEXT);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.wrappedKey).not.toBe(second.wrappedKey);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('zeroizes the plaintext data key after sealing', async () => {
    const { kms } = await seal();

    expect(kms.issued[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it.each(['ciphertext', 'tag', 'nonce', 'wrappedKey'] as const)(
    'rejects a sealed secret whose %s was tampered with',
    async (field) => {
      const { cipher, sealed } = await seal();
      const tampered = { ...sealed, [field]: flipFirstByte(sealed[field]) };

      await expect(cipher.open(tampered, CONTEXT)).rejects.toBeInstanceOf(SecretDecryptionError);
    },
  );

  it.each<[string, Partial<SecretContext>]>([
    ['another tenant', { tenantId: '22222222-2222-4222-8222-222222222222' }],
    ['another secret kind', { kind: 'certificate' }],
    ['another environment', { environment: 'production' }],
    ['another version', { version: 2 }],
  ])('rejects opening under %s (AAD mismatch)', async (_label, override) => {
    const { cipher, sealed } = await seal();

    await expect(cipher.open(sealed, { ...CONTEXT, ...override })).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it('rejects an unknown format version or key id', async () => {
    const { cipher, sealed } = await seal();

    await expect(cipher.open({ ...sealed, v: 2 }, CONTEXT)).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
    await expect(cipher.open({ ...sealed, keyId: 'other' }, CONTEXT)).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it('rejects a truncated nonce or tag', async () => {
    const { cipher, sealed } = await seal();

    await expect(cipher.open({ ...sealed, nonce: 'AAAA' }, CONTEXT)).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
    await expect(cipher.open({ ...sealed, tag: 'AAAA' }, CONTEXT)).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a non-object', 'sealed'],
    ['an object missing fields', { v: 1, keyId: 'fake:1' }],
    [
      'fields of the wrong type',
      { v: 1, keyId: 1, wrappedKey: 1, nonce: 1, tag: 1, ciphertext: 1 },
    ],
  ])('rejects %s with the opaque error, never a raw TypeError', async (_label, malformed) => {
    const { cipher } = await seal();

    await expect(cipher.open(malformed as SealedSecret, CONTEXT)).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it.each([
    ['trailing garbage', (value: string) => `${value}!!`],
    ['embedded whitespace', (value: string) => `${value.slice(0, 4)} ${value.slice(4)}`],
    ['base64url alphabet', (value: string) => value.replace(/\+/g, '-').replace(/\//g, '_')],
    ['missing padding', (value: string) => value.replace(/=+$/, '')],
  ])('rejects non-canonical base64 (%s) in any field', async (_label, mangle) => {
    const { cipher, sealed } = await seal();
    const fields = ['ciphertext', 'tag', 'nonce', 'wrappedKey'] as const;

    for (const field of fields) {
      const mangled = mangle(sealed[field]);
      if (mangled === sealed[field]) continue;
      await expect(cipher.open({ ...sealed, [field]: mangled }, CONTEXT)).rejects.toBeInstanceOf(
        SecretDecryptionError,
      );
    }
  });

  it('rejects trailing garbage appended to an otherwise valid ciphertext', async () => {
    const { cipher, sealed } = await seal();

    await expect(
      cipher.open({ ...sealed, ciphertext: `${sealed.ciphertext}!!` }, CONTEXT),
    ).rejects.toBeInstanceOf(SecretDecryptionError);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses a version that is not a non-negative safe integer (%s)',
    async (version) => {
      const { cipher, sealed } = await seal();

      await expect(cipher.seal(Buffer.from(SECRET), { ...CONTEXT, version })).rejects.toThrow(
        RangeError,
      );
      await expect(cipher.open(sealed, { ...CONTEXT, version })).rejects.toBeInstanceOf(
        SecretDecryptionError,
      );
    },
  );

  it('leaks no secret material in the error message', async () => {
    const { cipher, sealed } = await seal();
    const other = { ...CONTEXT, tenantId: '22222222-2222-4222-8222-222222222222' };

    const error = await cipher.open(sealed, other).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SecretDecryptionError);
    const text = `${String(error)} ${JSON.stringify(error)}`;
    for (const value of [
      SECRET,
      sealed.ciphertext,
      sealed.wrappedKey,
      sealed.tag,
      other.tenantId,
    ]) {
      expect(text).not.toContain(value);
    }
    expect((error as Error).cause).toBeUndefined();
  });

  describe('KMS outages are transient, not decryption failures', () => {
    const failing = (error: Error) => {
      const kms = new FakeKms();
      return {
        kms,
        cipher: new EnvelopeCipher({
          ...kms,
          generateDataKey: () => kms.generateDataKey(),
          unwrapDataKey: () => Promise.reject(error),
        }),
      };
    };

    it('turns any non-KeyUnwrapError failure of unwrapDataKey into KeyServiceUnavailableError, with no detail', async () => {
      const { sealed } = await seal();
      const { cipher } = failing(
        Object.assign(new Error('connect ECONNRESET 10.0.0.7 token=s3cret-token'), {
          code: 'ECONNRESET',
        }),
      );

      const error = await cipher.open(sealed, CONTEXT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(KeyServiceUnavailableError);
      expect(error).not.toBeInstanceOf(SecretDecryptionError);
      expect((error as Error).cause).toBeUndefined();
      const text =
        JSON.stringify(error) + String((error as Error).message) + String((error as Error).stack);
      expect(text).not.toContain('s3cret-token');
      expect(text).not.toContain('10.0.0.7');
    });

    it('lets a KeyServiceUnavailableError from the KMS through', async () => {
      const { sealed } = await seal();
      const { cipher } = failing(new KeyServiceUnavailableError());
      await expect(cipher.open(sealed, CONTEXT)).rejects.toBeInstanceOf(KeyServiceUnavailableError);
    });

    it('keeps SecretDecryptionError for an unknown key or a rejected wrapped key', async () => {
      const { sealed } = await seal();
      const { cipher } = failing(new KeyUnwrapError());
      await expect(cipher.open(sealed, CONTEXT)).rejects.toBeInstanceOf(SecretDecryptionError);
    });
  });
});
