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

/**
 * Thrown by {@link import('./session-guard.js').assertNonPrivilegedSession}
 * when the connected database session can bypass RLS. See that function's
 * docstring for why this check exists.
 */
export class PrivilegedSessionError extends Error {
  constructor(session: { rolsuper: boolean; rolbypassrls: boolean; ownsTenantTable: boolean } | undefined) {
    super(
      'Refusing to run application queries: the connected session can bypass RLS ' +
        `(rolsuper=${String(session?.rolsuper)}, rolbypassrls=${String(session?.rolbypassrls)}, ` +
        `ownsTenantTable=${String(session?.ownsTenantTable)}). Connect as app_login instead.`,
    );
    this.name = 'PrivilegedSessionError';
  }
}
