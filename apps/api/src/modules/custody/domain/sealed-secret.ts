/** What a sealed secret protects (ADR-0009): a tenant's CSC or its `.p12`. */
export type SecretKind = 'csc' | 'certificate';

/**
 * Identity a ciphertext is cryptographically bound to (AES-GCM AAD). Opening
 * it under any other tenant, kind, environment or version fails, so a stored
 * blob cannot be swapped between rows.
 */
export interface SecretContext {
  readonly tenantId: string;
  readonly kind: SecretKind;
  readonly environment: 'test' | 'production';
  readonly version: number;
}

export const SEALED_SECRET_FORMAT = 1;

/** Envelope-encrypted secret; binary fields are base64 so it can be stored as JSON. */
export interface SealedSecret {
  /** Format version; only {@link SEALED_SECRET_FORMAT} is accepted. */
  readonly v: number;
  readonly keyId: string;
  readonly wrappedKey: string;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/**
 * A sealed secret could not be opened (tampered, wrong context, unknown key).
 * Deliberately carries no detail and no cause: nothing about the secret, the
 * key or the tenant may reach a log or a response.
 */
export class SecretDecryptionError extends Error {
  constructor() {
    super('sealed secret could not be opened');
    this.name = 'SecretDecryptionError';
  }
}

/** Unambiguous AAD encoding of the format version and the {@link SecretContext}. */
export function encodeAad(context: SecretContext): Buffer {
  const { tenantId, kind, environment, version } = context;
  return Buffer.from(
    JSON.stringify([SEALED_SECRET_FORMAT, tenantId, kind, environment, version]),
    'utf8',
  );
}
