import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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

  it('uses a constant key id that reveals nothing derived from the master key', async () => {
    const first = await createLocalKms(MASTER_KEY, 'production').generateDataKey();
    const other = createLocalKms(randomBytes(32).toString('base64'), 'production');

    expect(first.keyId).toBe('local:v1');
    expect((await other.generateDataKey()).keyId).toBe(first.keyId);
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
  it.each([undefined, '', 'production', 'Production', 'staging', 'dev'])(
    'fails closed without a master key when NODE_ENV is %j',
    (nodeEnv) => {
      const warn = vi.fn();

      expect(() => createLocalKms(undefined, nodeEnv, warn)).toThrow(/KMS_LOCAL_MASTER_KEY/);
      expect(() => createLocalKms('', nodeEnv, warn)).toThrow(/KMS_LOCAL_MASTER_KEY/);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(['development', 'test'])(
    'uses a throwaway random master key with a loud warning when NODE_ENV=%s',
    async (nodeEnv) => {
      const warn = vi.fn();
      const first = createLocalKms(undefined, nodeEnv, warn);
      const second = createLocalKms(undefined, nodeEnv, warn);
      const { wrappedKey, keyId } = await first.generateDataKey();

      expect(first).toBeInstanceOf(LocalKmsAdapter);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/will not survive a restart/));
      await expect(second.unwrapDataKey(wrappedKey, keyId)).rejects.toBeInstanceOf(KeyUnwrapError);
    },
  );

  const canonical = Buffer.alloc(32, 0xfb).toString('base64');
  it.each([
    ['too short', Buffer.alloc(31).toString('base64')],
    ['too long', Buffer.alloc(33).toString('base64')],
    ['garbage', 'not base64 at all!!'],
    ['base64url', canonical.replace(/\+/g, '-').replace(/\//g, '_')],
    ['missing padding', canonical.replace(/=+$/, '')],
    ['trailing newline', `${canonical}\n`],
    ['surrounding spaces', ` ${canonical} `],
  ])('rejects a %s master key without echoing it', (_label, value) => {
    const attempt = (): unknown => createLocalKms(value, 'production');

    expect(attempt).toThrow(/KMS_LOCAL_MASTER_KEY must be 32 bytes of canonical base64/);
    expect(attempt).not.toThrow(value.trim());
  });

  it('accepts a canonical 32-byte master key in any environment', () => {
    expect(createLocalKms(canonical, 'production')).toBeInstanceOf(LocalKmsAdapter);
    expect(createLocalKms(canonical, undefined)).toBeInstanceOf(LocalKmsAdapter);
  });
});
