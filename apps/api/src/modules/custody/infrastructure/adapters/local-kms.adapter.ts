import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { DataKey, KeyManagementService } from '../../application/ports/key-management.port.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A wrapped data key could not be unwrapped. Carries no key material. */
export class KeyUnwrapError extends Error {
  constructor() {
    super('data key could not be unwrapped');
    this.name = 'KeyUnwrapError';
  }
}

/**
 * {@link KeyManagementService} backed by an in-process master key, for local,
 * dev and test (ADR-0009). Wraps each data key with AES-256-GCM as
 * `nonce | tag | encrypted key`, authenticated with the key id. A cloud KMS
 * (or Vault Transit) adapter replaces it in real deployments; not built yet.
 */
export class LocalKmsAdapter implements KeyManagementService {
  private readonly keyId: string;

  constructor(private readonly masterKey: Buffer) {
    // Non-reversible fingerprint so a blob sealed under another master key is
    // recognised as foreign instead of failing obscurely.
    this.keyId = `local:${createHash('sha256').update(masterKey).digest('hex').slice(0, 16)}`;
  }

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
 * Builds the local KMS from `KMS_LOCAL_MASTER_KEY` (base64 of 32 bytes).
 * Fails closed under `NODE_ENV=production` when it is missing; elsewhere an
 * ephemeral random master key is used, so secrets sealed in one process do
 * not survive a restart. There is never a hardcoded fallback key.
 */
export function createLocalKms(
  masterKeyBase64: string | undefined,
  nodeEnv: string | undefined,
): LocalKmsAdapter {
  if (masterKeyBase64 === undefined || masterKeyBase64 === '') {
    if (nodeEnv === 'production') {
      throw new Error('KMS_LOCAL_MASTER_KEY must be set when NODE_ENV=production.');
    }
    return new LocalKmsAdapter(randomBytes(KEY_BYTES));
  }
  const masterKey = Buffer.from(masterKeyBase64, 'base64');
  if (masterKey.length !== KEY_BYTES) {
    masterKey.fill(0);
    throw new Error('KMS_LOCAL_MASTER_KEY must be 32 bytes encoded in base64.');
  }
  return new LocalKmsAdapter(masterKey);
}
