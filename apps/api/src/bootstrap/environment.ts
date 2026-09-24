export type SifenEnvironment = 'production' | 'test';

/**
 * Which SIFEN environment this deployment authenticates against
 * (backlog HU-E1-04): an `sk_live_` key is only accepted when this is
 * `"production"`, and `sk_test_` only when it is `"test"`.
 */
export function parseSifenEnvironment(value: string | undefined): SifenEnvironment {
  if (value === undefined || value === 'test') {
    return 'test';
  }
  if (value === 'production') {
    return 'production';
  }

  throw new Error(`Invalid SIFEN_ENVIRONMENT value: ${JSON.stringify(value)}`);
}
