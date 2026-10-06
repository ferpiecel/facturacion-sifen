/** Invalid session settings; messages never carry the offending value. */
export class SessionConfigError extends Error {
  override name = 'SessionConfigError';
}

export interface SessionConfig {
  /** Life of an access token (PO decision: 5 minutes). */
  readonly accessTtlSeconds: number;
  /** Life of a refresh token, sliding on every refresh (PO decision: 10 minutes). */
  readonly refreshTtlSeconds: number;
  /** Hard cap from login; a refresh never extends past it (PO decision: 12 h, 20 min in development and test). */
  readonly absoluteTtlSeconds: number;
}

const ACCESS_DEFAULT = 300;
const REFRESH_DEFAULT = 600;
const ABSOLUTE_PRODUCTION = 43_200;
const ABSOLUTE_LOWER_ENVIRONMENT = 1_200;

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  // Plain decimal digits only: Number() would also accept '1e3', '0x12c', ' 300 ', '300.0' or '+300'.
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SessionConfigError(`${name} is out of range`);
  }
  return value;
}

/**
 * Reads the session settings, failing fast at startup like `loadWorkerConfig`. The defaults follow
 * `NODE_ENV`: only `development` and `test` get the short absolute cap (so expiry can be exercised);
 * anything else, including an unset or unknown value, gets the production values (the safe default).
 */
export function loadSessionConfig(env: NodeJS.ProcessEnv): SessionConfig {
  const lower = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  const config = {
    accessTtlSeconds: integer(env, 'SESSION_ACCESS_TTL_SECONDS', ACCESS_DEFAULT, 30, 3_600),
    refreshTtlSeconds: integer(env, 'SESSION_REFRESH_TTL_SECONDS', REFRESH_DEFAULT, 60, 86_400),
    absoluteTtlSeconds: integer(
      env,
      'SESSION_ABSOLUTE_TTL_SECONDS',
      lower ? ABSOLUTE_LOWER_ENVIRONMENT : ABSOLUTE_PRODUCTION,
      300,
      604_800,
    ),
  };
  if (
    config.accessTtlSeconds > config.refreshTtlSeconds ||
    config.refreshTtlSeconds > config.absoluteTtlSeconds
  ) {
    throw new SessionConfigError('session lifetimes must satisfy access <= refresh <= absolute');
  }
  return config;
}
