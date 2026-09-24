import { hash as argon2Hash, verify } from '@node-rs/argon2';
import type { SecretVerifier } from '../../application/ports/secret-verifier.port.js';

/**
 * The Argon2id cost parameters this project pins explicitly, rather than
 * relying on `@node-rs/argon2`'s own defaults (which could change across
 * versions). {@link AuthenticateApiKeyUseCase}'s `DUMMY_HASH` is a real
 * hash encoded with exactly these values — a test asserts that equality —
 * so a lookup miss and a lookup hit always cost the same amount of work.
 */
export const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

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
