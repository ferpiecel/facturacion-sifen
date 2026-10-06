export interface AuthEvent {
  /** e.g. `login.password_failed`, `login.locked`, `login.mfa_failed`, `login.succeeded`. */
  event: string;
  userId: string | null;
  /** The email, IP or user the event concerns; stored hashed. Never a password or a code. */
  subject: string;
  detail?: Record<string, string | number | boolean>;
}

/** Trail of authentication events that happen before a tenant is active (D4); append-only. */
export interface AuthEventLog {
  record(event: AuthEvent): Promise<void>;
}
