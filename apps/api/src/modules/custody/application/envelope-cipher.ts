import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  SEALED_SECRET_FORMAT,
  SecretDecryptionError,
  encodeAad,
  type SealedSecret,
  type SecretContext,
} from '../domain/sealed-secret.js';
import type { KeyManagementService } from './ports/key-management.port.js';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Envelope encryption (ADR-0009): every secret gets its own KMS data key and a
 * random 96-bit nonce, and AES-256-GCM authenticates it together with its
 * {@link SecretContext}. Data keys in clear are zeroized after use.
 */
export class EnvelopeCipher {
  constructor(private readonly kms: KeyManagementService) {}

  async seal(plaintext: Buffer, context: SecretContext): Promise<SealedSecret> {
    const { plaintextKey, wrappedKey, keyId } = await this.kms.generateDataKey();
    try {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, plaintextKey, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(encodeAad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        v: SEALED_SECRET_FORMAT,
        keyId,
        wrappedKey: wrappedKey.toString('base64'),
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } finally {
      plaintextKey.fill(0);
    }
  }

  /**
   * Returns the secret in clear, for in-memory use only; the caller should
   * zeroize it when done.
   *
   * @throws SecretDecryptionError on any tampering, context mismatch or unknown key.
   */
  async open(sealed: SealedSecret, context: SecretContext): Promise<Buffer> {
    const nonce = Buffer.from(sealed.nonce, 'base64');
    const tag = Buffer.from(sealed.tag, 'base64');
    if (
      sealed.v !== SEALED_SECRET_FORMAT ||
      nonce.length !== NONCE_BYTES ||
      tag.length !== TAG_BYTES
    ) {
      throw new SecretDecryptionError();
    }

    let dataKey: Buffer | undefined;
    try {
      dataKey = await this.kms.unwrapDataKey(
        Buffer.from(sealed.wrappedKey, 'base64'),
        sealed.keyId,
      );
      const decipher = createDecipheriv(ALGORITHM, dataKey, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(encodeAad(context));
      decipher.setAuthTag(tag);
      const ciphertext = Buffer.from(sealed.ciphertext, 'base64');
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // No cause attached: KMS or OpenSSL errors must not leak into logs.
      throw new SecretDecryptionError();
    } finally {
      dataKey?.fill(0);
    }
  }
}
