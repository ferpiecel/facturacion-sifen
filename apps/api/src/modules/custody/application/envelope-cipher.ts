import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  SEALED_SECRET_FORMAT,
  SecretDecryptionError,
  decodeCanonicalBase64,
  encodeAad,
  type SealedSecret,
  type SecretContext,
} from '../domain/sealed-secret.js';
import {
  KeyServiceUnavailableError,
  KeyUnwrapError,
  type KeyManagementService,
} from './ports/key-management.port.js';

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
   * zeroize it when done. Zeroized here: the unwrapped data key and the
   * intermediate decipher chunks (including unauthenticated plaintext when the
   * tag check fails). Not zeroized: the returned buffer, which the caller owns.
   *
   * @throws SecretDecryptionError on any malformed input, tampering, context
   *   mismatch or a key the KMS permanently refuses ({@link KeyUnwrapError}).
   * @throws KeyServiceUnavailableError when the KMS call fails for any other reason (transient).
   */
  async open(sealed: SealedSecret, context: SecretContext): Promise<Buffer> {
    let dataKey: Buffer | undefined;
    const chunks: Buffer[] = [];
    try {
      const nonce = decodeCanonicalBase64(sealed.nonce);
      const tag = decodeCanonicalBase64(sealed.tag);
      const ciphertext = decodeCanonicalBase64(sealed.ciphertext);
      const wrappedKey = decodeCanonicalBase64(sealed.wrappedKey);
      if (
        sealed.v !== SEALED_SECRET_FORMAT ||
        typeof sealed.keyId !== 'string' ||
        nonce.length !== NONCE_BYTES ||
        tag.length !== TAG_BYTES
      ) {
        throw new SecretDecryptionError();
      }
      dataKey = await this.unwrap(wrappedKey, sealed.keyId);
      const decipher = createDecipheriv(ALGORITHM, dataKey, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(encodeAad(context));
      decipher.setAuthTag(tag);
      chunks.push(decipher.update(ciphertext));
      chunks.push(decipher.final());
      return Buffer.concat(chunks);
    } catch (error) {
      // A KMS outage is retryable; never report it as a (permanent) decryption failure.
      if (error instanceof KeyServiceUnavailableError) throw error;
      // No cause attached: parse, KMS or OpenSSL errors must not leak into logs.
      throw new SecretDecryptionError();
    } finally {
      dataKey?.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  }

  /** Only a {@link KeyUnwrapError} is a permanent refusal; anything else is assumed transient. */
  private async unwrap(wrappedKey: Buffer, keyId: string): Promise<Buffer> {
    try {
      return await this.kms.unwrapDataKey(wrappedKey, keyId);
    } catch (error) {
      // Neither the cause nor its message is carried over (endpoints, tokens).
      throw error instanceof KeyUnwrapError ? error : new KeyServiceUnavailableError();
    }
  }
}
