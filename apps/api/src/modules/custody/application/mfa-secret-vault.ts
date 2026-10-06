import type { SealedSecret, SecretContext } from '../domain/sealed-secret.js';
import type { EnvelopeCipher } from './envelope-cipher.js';

/** A user belongs to no single tenant, so the AAD's tenant slot carries this constant instead. */
const PLATFORM_SCOPE = 'platform';
const MFA_SECRET_VERSION = 1;

/**
 * Custody of portal users' TOTP secrets (ADR-0009, HU-E1-07): sealed on enrolment and opened in memory
 * only to check a code. The AAD binds the user id, so a blob cannot be moved to another account.
 */
export class MfaSecretVault {
  constructor(private readonly cipher: EnvelopeCipher) {}

  private context(userId: string): SecretContext {
    return {
      tenantId: PLATFORM_SCOPE,
      kind: 'mfa',
      environment: 'none',
      version: MFA_SECRET_VERSION,
      label: userId,
    };
  }

  seal(secret: Buffer, userId: string): Promise<SealedSecret> {
    return this.cipher.seal(secret, this.context(userId));
  }

  /** The secret in clear; the caller zeroizes it. @throws SecretDecryptionError on a mismatch. */
  open(sealed: SealedSecret, userId: string): Promise<Buffer> {
    return this.cipher.open(sealed, this.context(userId));
  }
}
