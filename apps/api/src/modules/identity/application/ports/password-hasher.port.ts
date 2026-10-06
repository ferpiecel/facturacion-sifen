/**
 * Hashes a portal user's password before it is persisted (HU-E1-07). The Argon2id adapter shared with
 * API keys implements it with the pinned `ARGON2_PARAMS`, so passwords and keys cost the same to attack.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
}
