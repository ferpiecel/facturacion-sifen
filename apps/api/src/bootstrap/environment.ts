export type SifenEnvironment = 'production' | 'test';

/**
 * Which SIFEN environment this deployment authenticates against
 * (backlog HU-E1-04): an `sk_live_` key is only accepted when this is
 * `"production"`, and `sk_test_` only when it is `"test"`.
 *
 * Defaults to `"test"` when unset, EXCEPT under `NODE_ENV=production`: a
 * production deployment that forgot to set `SIFEN_ENVIRONMENT` must fail to
 * start rather than silently boot accepting only `sk_test_...` keys (or
 * worse, accept `sk_live_...` under an unintended default) — fail closed,
 * not open.
 */
export function parseSifenEnvironment(
  value: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SifenEnvironment {
  if (value === undefined) {
    if (nodeEnv === 'production') {
      throw new Error(
        'SIFEN_ENVIRONMENT must be set explicitly ("test" or "production") when NODE_ENV=production.',
      );
    }
    return 'test';
  }
  if (value === 'test' || value === 'production') {
    return value;
  }

  throw new Error(`Invalid SIFEN_ENVIRONMENT value: ${JSON.stringify(value)}`);
}
