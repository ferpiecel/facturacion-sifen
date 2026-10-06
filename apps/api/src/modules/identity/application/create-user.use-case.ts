import { normalizeEmail } from '../domain/email.js';
import {
  normalizePassword,
  validatePassword,
  type PasswordIssue,
} from '../domain/password-policy.js';
import type { PasswordHasher } from './ports/password-hasher.port.js';

export type UserIssue = PasswordIssue | 'invalid_email' | 'invalid_display_name';

/** The input breaks a rule; `issues` carries codes only, never the password. */
export class InvalidUserError extends Error {
  constructor(readonly issues: UserIssue[]) {
    super(`invalid user: ${issues.join(', ')}`);
    this.name = 'InvalidUserError';
  }
}

export interface NewUser {
  email: string;
  displayName: string;
  password: string;
}

export interface UserToPersist {
  email: string;
  displayName: string;
  passwordHash: string;
}

const MAX_DISPLAY_NAME_LENGTH = 255;

/** Validates and prepares a portal user for persistence (HU-E1-07); the operator CLI persists it. */
export class CreateUserUseCase {
  constructor(private readonly hasher: PasswordHasher) {}

  async execute(input: NewUser): Promise<UserToPersist> {
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    const issues: UserIssue[] = [];
    if (!email) issues.push('invalid_email');
    if (displayName === '' || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      issues.push('invalid_display_name');
    }
    issues.push(...validatePassword(input.password, { email: email ?? undefined }));
    if (issues.length > 0 || !email) {
      throw new InvalidUserError(issues);
    }
    return {
      email,
      displayName,
      passwordHash: await this.hasher.hash(normalizePassword(input.password)),
    };
  }
}
