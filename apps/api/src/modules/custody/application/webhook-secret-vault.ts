import type { SealedSecret, SecretContext } from '../domain/sealed-secret.js';
import type { EnvelopeCipher } from './envelope-cipher.js';

/** Which secret a sealed blob protects: bound into its AAD, so it cannot be moved between rows. */
export interface WebhookSecretIdentity {
  readonly tenantId: string;
  readonly endpointId: string;
  readonly version: number;
}

/** The secret columns of a `webhook_endpoints` row plus the clock the overlap is judged against. */
export interface WebhookSigningInput {
  readonly tenantId: string;
  readonly endpointId: string;
  readonly secretVersion: number;
  readonly sealed: SealedSecret;
  readonly previousSealed: SealedSecret | null;
  readonly previousExpiresAt: Date | null;
  readonly now: Date;
}

/**
 * Custody of webhook signing secrets (ADR-0009): sealed on create and rotate, opened in memory only
 * to sign. The AAD binds tenant, endpoint id and secret version; the previous secret of a rotation
 * overlap is the one sealed under `version - 1`.
 */
export class WebhookSecretVault {
  constructor(private readonly cipher: EnvelopeCipher) {}

  private context({ tenantId, endpointId, version }: WebhookSecretIdentity): SecretContext {
    return { tenantId, kind: 'webhook', environment: 'none', version, label: endpointId };
  }

  seal(secret: string, identity: WebhookSecretIdentity): Promise<SealedSecret> {
    return this.cipher.seal(Buffer.from(secret, 'utf8'), this.context(identity));
  }

  /**
   * Secrets to sign a delivery with: the current one first, then the previous one while its overlap
   * has not expired (the header then carries one `v1` per secret).
   *
   * @throws SecretDecryptionError when a blob does not match its identity.
   */
  async signingSecrets(input: WebhookSigningInput): Promise<string[]> {
    const { tenantId, endpointId, secretVersion } = input;
    const open = async (sealed: SealedSecret, version: number): Promise<string> => {
      const plaintext = await this.cipher.open(
        sealed,
        this.context({ tenantId, endpointId, version }),
      );
      try {
        return plaintext.toString('utf8');
      } finally {
        plaintext.fill(0);
      }
    };
    const secrets = [await open(input.sealed, secretVersion)];
    if (
      input.previousSealed !== null &&
      input.previousExpiresAt !== null &&
      input.previousExpiresAt.getTime() > input.now.getTime()
    ) {
      secrets.push(await open(input.previousSealed, secretVersion - 1));
    }
    return secrets;
  }
}
