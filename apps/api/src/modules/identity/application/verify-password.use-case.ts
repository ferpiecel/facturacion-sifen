import { normalizeEmail } from '../domain/email.js';
import {
  MAX_PASSWORD_LENGTH,
  normalizePassword,
  passwordLength,
} from '../domain/password-policy.js';
import { DUMMY_HASH } from './authenticate-api-key.use-case.js';
import type { SecretVerifier } from './ports/secret-verifier.port.js';
import type { UserCredentialLookup } from './ports/user-credential-lookup.port.js';

/**
 * Checks an email and password pair (HU-E1-07). Returns `null` for every failure (malformed email,
 * unknown user, disabled user, wrong password) so the caller cannot tell them apart, and always spends
 * exactly one Argon2id verification: an unknown or malformed email is verified against
 * {@link DUMMY_HASH}, so latency does not reveal whether the account exists.
 */
export class VerifyPasswordUseCase {
  constructor(
    private readonly lookup: UserCredentialLookup,
    private readonly verifier: SecretVerifier,
  ) {}

  async execute(rawEmail: string, password: string): Promise<{ userId: string } | null> {
    const email = normalizeEmail(rawEmail);
    const user = email ? await this.lookup.findByEmail(email) : null;
    // An oversized password cannot be a real one (the policy caps it): still one dummy verification,
    // never Argon2 over the whole input.
    const oversized = passwordLength(password) > MAX_PASSWORD_LENGTH;
    const valid = await (oversized
      ? this.verifier.verify('', DUMMY_HASH)
      : this.verifier.verify(normalizePassword(password), user?.passwordHash ?? DUMMY_HASH));
    return user && valid && !oversized && !user.disabled ? { userId: user.userId } : null;
  }
}
