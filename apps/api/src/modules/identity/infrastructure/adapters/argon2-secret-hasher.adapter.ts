import { hash as argon2Hash } from '@node-rs/argon2';
import { ARGON2_PARAMS } from '../../domain/argon2-params.js';
import type { SecretHasher } from '../../application/ports/secret-hasher.port.js';

/**
 * Hashes a newly minted secret (backlog HU-E1-05) with exactly the same
 * {@link ARGON2_PARAMS} {@link Argon2SecretVerifierAdapter} verifies
 * against, so an issued key always authenticates.
 */
export class Argon2SecretHasherAdapter implements SecretHasher {
  async hash(secret: string): Promise<string> {
    return argon2Hash(secret, ARGON2_PARAMS);
  }
}
