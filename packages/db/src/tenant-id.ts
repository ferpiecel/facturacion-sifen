import { InvalidTenantIdError } from './errors.js';

// Accepts any RFC 4122 UUID variant/version (drizzle's `uuid()` column
// accepts the same range). Deliberately anchored and case-insensitive.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidTenantId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Validates before any SQL is built. A non-UUID string (including a
 * SQL-injection payload) is rejected here, never string-interpolated into
 * a query.
 */
export function assertValidTenantId(value: unknown): asserts value is string {
  if (!isValidTenantId(value)) {
    throw new InvalidTenantIdError(value);
  }
}
