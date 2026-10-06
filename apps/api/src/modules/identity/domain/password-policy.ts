/**
 * Password policy for portal users (HU-E1-07), following NIST SP 800-63B: length over composition.
 *
 * - No composition rules (no "one capital, one digit, one symbol") and no forced rotation: they push
 *   people to predictable patterns. Any character is allowed, including spaces and non-ASCII.
 * - A floor of 12 characters (the password is one factor next to TOTP, where NIST accepts 8, but the
 *   account must also survive a leaked second factor) and a ceiling of 128, rejected rather than
 *   truncated; Argon2id has no 72-byte limit.
 * - Candidates are compared in NFKC and counted in code points, so the same text typed on different
 *   keyboards or normalization forms counts the same.
 * - Blocklist: a small embedded list of the most common passwords, plain sequences and repeats, plus
 *   context-specific words (the service name and the account's own email). A breached-password
 *   corpus (k-anonymity range lookup) belongs behind a port later; this module stays offline.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordIssue = 'too_short' | 'too_long' | 'common' | 'context_specific';

export interface PasswordContext {
  email?: string;
}

const COMMON_BASES = new Set(
  'password passw0rd contrasena contraseña qwerty qwertyuiop letmein welcome admin administrator iloveyou monkey dragon football baseball master login abc trustno sunshine princess shadow superman batman freedom whatever changeme secret hello asuncion paraguay guarani password123'.split(
    ' ',
  ),
);

/** Runs of these are "sequences": any substring of them, forwards or backwards, is predictable. */
const SEQUENCES = [
  '01234567890123456789',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
].flatMap((run) => [run, Array.from(run).reverse().join('')]);

const SERVICE_WORDS = ['sifen', 'facturacion'];
const MIN_CONTEXT_WORD_LENGTH = 4;

/**
 * The one canonical form of a password: hashing, verification and the policy all use it, so the same
 * text typed on another keyboard or in another Unicode form is the same secret.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/** Length in code points of the normalized form (what `varchar` limits and the policy count). */
export function passwordLength(password: string): number {
  return Array.from(normalizePassword(password)).length;
}

function isCommon(candidate: string): boolean {
  const squashed = candidate.toLowerCase().replace(/\s+/g, '');
  const base = squashed.replace(/[^\p{L}]+$/u, '');
  return (
    COMMON_BASES.has(squashed) ||
    COMMON_BASES.has(base) ||
    new Set(squashed).size === 1 ||
    SEQUENCES.some((run) => run.includes(squashed))
  );
}

function isContextSpecific(candidate: string, context: PasswordContext): boolean {
  const lowered = candidate.toLowerCase();
  const local = context.email?.split('@')[0]?.toLowerCase() ?? '';
  const words = local.length >= MIN_CONTEXT_WORD_LENGTH ? [...SERVICE_WORDS, local] : SERVICE_WORDS;
  return words.some((word) => lowered.includes(word));
}

/** Returns every policy issue of `password`; an empty list means it is acceptable. */
export function validatePassword(password: string, context: PasswordContext = {}): PasswordIssue[] {
  const candidate = normalizePassword(password);
  const length = passwordLength(candidate);
  const issues: PasswordIssue[] = [];
  if (length < MIN_PASSWORD_LENGTH) issues.push('too_short');
  if (length > MAX_PASSWORD_LENGTH) issues.push('too_long');
  if (isCommon(candidate)) issues.push('common');
  if (isContextSpecific(candidate, context)) issues.push('context_specific');
  return issues;
}
