/** What a sealed secret protects (ADR-0009): a tenant's CSC, its `.p12` or a webhook signing secret. */
export type SecretKind = 'csc' | 'certificate' | 'webhook';

/**
 * Identity a ciphertext is cryptographically bound to (AES-GCM AAD). Opening
 * it under any other tenant, kind, environment or version fails, so a stored
 * blob cannot be swapped between rows.
 */
export interface SecretContext {
  readonly tenantId: string;
  readonly kind: SecretKind;
  /** `none` for secrets that are not tied to a SIFEN environment (webhook signing secrets). */
  readonly environment: 'test' | 'production' | 'none';
  readonly version: number;
  /** Optional slot identity (e.g. a CSC's idCSC); bound into the AAD when present. */
  readonly label?: string;
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

/**
 * Unambiguous AAD encoding of the format version and the {@link SecretContext}.
 *
 * @throws RangeError when `version` is not a non-negative safe integer.
 */
export function encodeAad(context: SecretContext): Buffer {
  const { tenantId, kind, environment, version, label } = context;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('secret version must be a non-negative safe integer');
  }
  return Buffer.from(
    JSON.stringify(
      label === undefined
        ? [SEALED_SECRET_FORMAT, tenantId, kind, environment, version]
        : [SEALED_SECRET_FORMAT, tenantId, kind, environment, version, label],
    ),
    'utf8',
  );
}

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes standard, padded base64 and rejects anything else (whitespace,
 * base64url, missing padding, garbage, non-strings), unlike `Buffer.from`,
 * which silently skips what it cannot parse.
 *
 * @throws TypeError when `value` is not canonical base64.
 */
export function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !CANONICAL_BASE64.test(value)) {
    throw new TypeError('value is not canonical base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new TypeError('value is not canonical base64');
  }
  return decoded;
}
