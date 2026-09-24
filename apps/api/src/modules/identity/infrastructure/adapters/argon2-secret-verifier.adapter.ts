import { hash as argon2Hash, verify } from '@node-rs/argon2';
import { ARGON2_PARAMS } from '../../domain/argon2-params.js';
import type { SecretVerifier } from '../../application/ports/secret-verifier.port.js';

/** Argon2id verification (backlog HU-E1-04). Never throws: a malformed hash is treated as "no match". */
export class Argon2SecretVerifierAdapter implements SecretVerifier {
  async verify(secret: string, hash: string): Promise<boolean> {
    try {
      return await verify(hash, secret);
    } catch {
      return false;
    }
  }

  /** Hashes a new secret with {@link ARGON2_PARAMS} (used whenever this project mints an api key). */
  async hash(secret: string): Promise<string> {
    return argon2Hash(secret, ARGON2_PARAMS);
  }
}
