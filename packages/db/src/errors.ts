/**
 * Thrown by {@link import('./tenant-id.js').assertValidTenantId} before any
 * SQL runs. Rejecting a malformed or hostile tenant id (e.g. a SQL
 * injection attempt) here means it never reaches `set_config`, even though
 * that call is parameterized and would not be injectable either way.
 */
export class InvalidTenantIdError extends Error {
  constructor(value: unknown) {
    super(
      `Invalid tenant id: expected a UUID, received ${
        typeof value === 'string' ? JSON.stringify(value) : String(value)
      }`,
    );
    this.name = 'InvalidTenantIdError';
  }
}
