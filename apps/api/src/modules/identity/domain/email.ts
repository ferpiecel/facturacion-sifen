export const MAX_EMAIL_LENGTH = 254;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s.][^@\s]*\.[^@\s.]+$/;

/** Trims and lower-cases (the `users.email` form); returns `null` when it is not a plausible address. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().normalize('NFKC').toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}
