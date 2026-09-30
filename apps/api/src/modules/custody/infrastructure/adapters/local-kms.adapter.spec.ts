import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyUnwrapError, LocalKmsAdapter, createLocalKms } from './local-kms.adapter.js';

const MASTER_KEY = randomBytes(32).toString('base64');

describe('LocalKmsAdapter', () => {
  it('unwraps the data key it generated', async () => {
    const kms = createLocalKms(MASTER_KEY, 'production');
    const dataKey = await kms.generateDataKey();

    const unwrapped = await kms.unwrapDataKey(dataKey.wrappedKey, dataKey.keyId);

    expect(dataKey.plaintextKey).toHaveLength(32);
    expect(unwrapped.equals(dataKey.plaintextKey)).toBe(true);
    expect(dataKey.wrappedKey.includes(dataKey.plaintextKey)).toBe(false);
  });

  it('issues a different data key every time', async () => {
    const kms = createLocalKms(MASTER_KEY, undefined);

    const first = await kms.generateDataKey();
    const second = await kms.generateDataKey();

    expect(first.plaintextKey.equals(second.plaintextKey)).toBe(false);
  });

  it('rejects a tampered wrapped key or a foreign key id with a typed error', async () => {
    const kms = createLocalKms(MASTER_KEY, undefined);
    const { wrappedKey, keyId } = await kms.generateDataKey();
    const tampered = Buffer.from(wrappedKey);
    const last = tampered.length - 1;
    tampered.writeUInt8(tampered.readUInt8(last) ^ 0x01, last);

    await expect(kms.unwrapDataKey(tampered, keyId)).rejects.toBeInstanceOf(KeyUnwrapError);
    await expect(kms.unwrapDataKey(wrappedKey, 'local:other')).rejects.toBeInstanceOf(
      KeyUnwrapError,
    );
    await expect(kms.unwrapDataKey(Buffer.alloc(4), keyId)).rejects.toBeInstanceOf(KeyUnwrapError);
  });

  it('cannot unwrap a key wrapped under another master key', async () => {
    const { wrappedKey, keyId } = await createLocalKms(MASTER_KEY, undefined).generateDataKey();
    const other = createLocalKms(randomBytes(32).toString('base64'), undefined);

    await expect(other.unwrapDataKey(wrappedKey, keyId)).rejects.toBeInstanceOf(KeyUnwrapError);
  });
});

describe('createLocalKms (startup)', () => {
  it('fails closed when NODE_ENV=production and the master key is missing', () => {
    expect(() => createLocalKms(undefined, 'production')).toThrow(/KMS_LOCAL_MASTER_KEY/);
    expect(() => createLocalKms('', 'production')).toThrow(/KMS_LOCAL_MASTER_KEY/);
  });

  it.each(['c2hvcnQ=', 'not base64 at all!!'])(
    'rejects a master key that is not 32 bytes of base64 without echoing it (%j)',
    (value) => {
      const attempt = (): unknown => createLocalKms(value, undefined);

      expect(attempt).toThrow(/KMS_LOCAL_MASTER_KEY must be 32 bytes/);
      expect(attempt).not.toThrow(value);
    },
  );

  it('uses an ephemeral random master key outside production when unset', async () => {
    const first = createLocalKms(undefined, 'development');
    const second = createLocalKms(undefined, undefined);
    const { wrappedKey, keyId } = await first.generateDataKey();

    expect(first).toBeInstanceOf(LocalKmsAdapter);
    await expect(second.unwrapDataKey(wrappedKey, keyId)).rejects.toBeInstanceOf(KeyUnwrapError);
  });
});
