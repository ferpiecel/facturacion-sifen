export interface UserCredential {
  userId: string;
  passwordHash: string;
  /** `users.disabled_at IS NOT NULL`. */
  disabled: boolean;
}

/** Pre-authentication read of a user by normalized email (a resolver role implements it; HU-E1-07 S4). */
export interface UserCredentialLookup {
  findByEmail(email: string): Promise<UserCredential | null>;
}
