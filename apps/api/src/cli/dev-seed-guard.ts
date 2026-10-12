/** The dev seed was asked to run where it must not; the message never carries the database URL. */
export class DevSeedRefusedError extends Error {
  constructor(reason: string) {
    super(`dev:seed refused: ${reason}`);
    this.name = 'DevSeedRefusedError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Guard of the dev-only seed: it creates a tenant with a known password, so it runs only with
 * `NODE_ENV` exactly `development` or `test` and only against a loopback database. A `host`
 * query parameter is refused too: node-postgres lets it override the URL's host.
 */
export function assertSafeDevSeedEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new DevSeedRefusedError('NODE_ENV must be exactly "development" or "test"');
  }
  const raw = env.OPS_DATABASE_URL;
  if (!raw) {
    throw new DevSeedRefusedError('OPS_DATABASE_URL is required');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DevSeedRefusedError('OPS_DATABASE_URL is not a valid URL');
  }
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    throw new DevSeedRefusedError('OPS_DATABASE_URL must not override the host by query parameter');
  }
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new DevSeedRefusedError('OPS_DATABASE_URL must point to a local database (localhost)');
  }
}
