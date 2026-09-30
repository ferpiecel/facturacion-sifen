/** A data key freshly issued by the KMS (ADR-0009 envelope encryption). */
export interface DataKey {
  /** 256-bit key in clear; the caller must zeroize it after use. */
  readonly plaintextKey: Buffer;
  /** The same key encrypted under the KMS master key; safe to persist. */
  readonly wrappedKey: Buffer;
  /** Identifies the master key that wrapped it. */
  readonly keyId: string;
}

/**
 * Key management service holding the master key (ADR-0009). Only data keys
 * cross this boundary; the master key never leaves the KMS.
 */
export interface KeyManagementService {
  generateDataKey(): Promise<DataKey>;
  /** Returns the data key in clear; the caller must zeroize it after use. */
  unwrapDataKey(wrappedKey: Buffer, keyId: string): Promise<Buffer>;
}
