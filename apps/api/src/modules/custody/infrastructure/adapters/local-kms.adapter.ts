import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  KeyUnwrapError,
  type DataKey,
  type KeyManagementService,
} from '../../application/ports/key-management.port.js';
import { decodeCanonicalBase64 } from '../../domain/sealed-secret.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Constant, not derived from the master key, so it gives no offline brute-force oracle. */
const LOCAL_KEY_ID = 'local:v1';
/** The only NODE_ENV values allowed to run without a configured master key. */
const THROWAWAY_KEY_ENVS: ReadonlySet<string | undefined> = new Set(['development', 'test']);

/**
 * {@link KeyManagementService} backed by an in-process master key (ADR-0009).
 * Wraps each data key with AES-256-GCM as `nonce | tag | encrypted key`,
 * authenticated with the key id. It is the only adapter today, so production
 * runs on it and must set a real `KMS_LOCAL_MASTER_KEY`; a cloud KMS (or Vault
 * Transit) adapter is pending and will replace it there.
 */
export class LocalKmsAdapter implements KeyManagementService {
  private readonly keyId = LOCAL_KEY_ID;

  constructor(private readonly masterKey: Buffer) {}

  generateDataKey(): Promise<DataKey> {
    const plaintextKey = randomBytes(KEY_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(this.keyId, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    const wrappedKey = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    return Promise.resolve({ plaintextKey, wrappedKey, keyId: this.keyId });
  }

  unwrapDataKey(wrappedKey: Buffer, keyId: string): Promise<Buffer> {
    if (keyId !== this.keyId || wrappedKey.length !== NONCE_BYTES + TAG_BYTES + KEY_BYTES) {
      return Promise.reject(new KeyUnwrapError());
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.masterKey,
        wrappedKey.subarray(0, NONCE_BYTES),
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(Buffer.from(keyId, 'utf8'));
      decipher.setAuthTag(wrappedKey.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
      const encrypted = wrappedKey.subarray(NONCE_BYTES + TAG_BYTES);
      return Promise.resolve(Buffer.concat([decipher.update(encrypted), decipher.final()]));
    } catch {
      return Promise.reject(new KeyUnwrapError());
    }
  }
}

/**
 * Builds the local KMS from `KMS_LOCAL_MASTER_KEY` (canonical base64 of 32
 * bytes). Fails closed unless `NODE_ENV` is exactly `development` or `test`:
 * only there may it run without the key, on a throwaway random master key
 * (announced with a warning) whose secrets do not survive a restart. There is
 * never a hardcoded fallback key. Errors never echo the configured value.
 */
export function createLocalKms(
  masterKeyBase64: string | undefined,
  nodeEnv: string | undefined,
  warn: (message: string) => void = (message) => {
    new Logger('LocalKms').warn(message);
  },
): LocalKmsAdapter {
  if (masterKeyBase64 === undefined || masterKeyBase64 === '') {
    if (!THROWAWAY_KEY_ENVS.has(nodeEnv)) {
      throw new Error(
        'KMS_LOCAL_MASTER_KEY must be set unless NODE_ENV is "development" or "test".',
      );
    }
    warn(
      'KMS_LOCAL_MASTER_KEY is not set: using a throwaway random master key. ' +
        'Secrets sealed now will not survive a restart.',
    );
    return new LocalKmsAdapter(randomBytes(KEY_BYTES));
  }
  let masterKey: Buffer;
  try {
    masterKey = decodeCanonicalBase64(masterKeyBase64);
  } catch {
    masterKey = Buffer.alloc(0);
  }
  if (masterKey.length !== KEY_BYTES) {
    masterKey.fill(0);
    throw new Error('KMS_LOCAL_MASTER_KEY must be 32 bytes of canonical base64.');
  }
  return new LocalKmsAdapter(masterKey);
}
