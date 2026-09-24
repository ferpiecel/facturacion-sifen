import { verify } from '@node-rs/argon2';
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
}
