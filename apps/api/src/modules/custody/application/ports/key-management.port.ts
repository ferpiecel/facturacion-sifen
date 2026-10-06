/** A data key freshly issued by the KMS (ADR-0009 envelope encryption). */
export interface DataKey {
  /** 256-bit key in clear; the caller must zeroize it after use. */
  readonly plaintextKey: Buffer;
  /** The same key encrypted under the KMS master key; safe to persist. */
  readonly wrappedKey: Buffer;
  /** Identifies the master key that wrapped it. */
  readonly keyId: string;
}

/** The KMS rejected a wrapped data key for good (unknown key id, tampered or malformed wrap). Carries no key material. */
export class KeyUnwrapError extends Error {
  constructor() {
    super('data key could not be unwrapped');
    this.name = 'KeyUnwrapError';
  }
}

/**
 * The KMS could not be reached or failed transiently (network, timeout, outage). Retrying later may
 * succeed, so callers must NOT treat it as a permanent decryption failure. Carries no cause or detail.
 */
export class KeyServiceUnavailableError extends Error {
  constructor() {
    super('key management service unavailable');
    this.name = 'KeyServiceUnavailableError';
  }
}

/**
 * Key management service holding the master key (ADR-0009). Only data keys
 * cross this boundary; the master key never leaves the KMS.
 */
export interface KeyManagementService {
  generateDataKey(): Promise<DataKey>;
  /**
   * Returns the data key in clear; the caller must zeroize it after use. Rejects with
   * {@link KeyUnwrapError} for a permanent refusal (unknown key id, bad wrap); any other rejection is
   * treated as transient ({@link KeyServiceUnavailableError}).
   */
  unwrapDataKey(wrappedKey: Buffer, keyId: string): Promise<Buffer>;
}
