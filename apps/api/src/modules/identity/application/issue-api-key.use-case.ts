import { formatApiKey, generateApiKeySecret } from '../domain/api-key-secret.js';
import type { ApiKeyEnvironment } from '../domain/api-key.js';
import type { SecretHasher } from './ports/secret-hasher.port.js';

export interface IssuedApiKey {
  /** The full bearer token: shown to the operator exactly once, never stored. */
  formattedKey: string;
  keyId: string;
  secretHash: string;
}

/**
 * Mints a new API key (backlog HU-E1-05): the domain generates `keyId` and
 * `secret`, and this use case hashes the secret through {@link SecretHasher}
 * before anything is persisted — the raw secret never reaches a repository.
 */
export class IssueApiKeyUseCase {
  constructor(private readonly hasher: SecretHasher) {}

  async execute(environment: ApiKeyEnvironment): Promise<IssuedApiKey> {
    const { keyId, secret } = generateApiKeySecret();
    const secretHash = await this.hasher.hash(secret);

    return { formattedKey: formatApiKey(environment, keyId, secret), keyId, secretHash };
  }
}
