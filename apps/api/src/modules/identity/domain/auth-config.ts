/** Invalid authentication settings; messages never carry the offending value. */
export class AuthConfigError extends Error {
  override name = 'AuthConfigError';
}

const MIN_PEPPER_BYTES = 32;
/** Used only when NODE_ENV is development or test, so local runs and specs need no secret. */
const DEVELOPMENT_PEPPER = 'sifen-development-pepper-not-a-secret!!';

/**
 * The HMAC key (pepper) for the hashed subjects of the login throttle and the auth event trail: emails and
 * IPs are pseudonymised with it, so a dictionary over the IPv4 space or known emails cannot reverse them
 * without the secret. Required (from the secret manager, `AUTH_SUBJECT_PEPPER`, at least 32 bytes) in every
 * environment except `development` and `test`; an unset or unknown `NODE_ENV` counts as production.
 */
export function loadAuthPepper(env: NodeJS.ProcessEnv): Buffer {
  const lower = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  const raw = env.AUTH_SUBJECT_PEPPER;
  if (raw === undefined || raw === '') {
    if (lower) return Buffer.from(DEVELOPMENT_PEPPER);
    throw new AuthConfigError('AUTH_SUBJECT_PEPPER is required');
  }
  const pepper = Buffer.from(raw);
  if (pepper.length < MIN_PEPPER_BYTES) {
    throw new AuthConfigError(
      `AUTH_SUBJECT_PEPPER must be at least ${String(MIN_PEPPER_BYTES)} bytes`,
    );
  }
  return pepper;
}
