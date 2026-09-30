/**
 * Vitest `globalSetup`. Starts a single `postgres:16` testcontainer for the
 * whole run when `DB_TEST_DRIVER=postgres` (CI's `db-postgres` job); a
 * no-op otherwise, so the default local/CI run (pglite) never touches
 * Docker.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.DB_TEST_DRIVER !== 'postgres') {
    return undefined;
  }

  const { GenericContainer, Wait } = await import('testcontainers');

  // The postgres image logs "ready to accept connections" twice: once for the
  // temporary init server and once for the real one. Connecting after the
  // first line races the restart and fails with 57P03 ("starting up").
  const container = await new GenericContainer('postgres:16')
    .withEnvironment({
      POSTGRES_USER: 'sifen',
      POSTGRES_PASSWORD: 'sifen',
      POSTGRES_DB: 'sifen',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const mappedPort = container.getMappedPort(5432).toString(10);
  process.env.DB_TEST_POSTGRES_URL = `postgres://sifen:sifen@${container.getHost()}:${mappedPort}/sifen`;

  // Unsafe pre-existing app_login: proves the migration re-asserts attributes.
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString: process.env.DB_TEST_POSTGRES_URL });
  try {
    await admin.query(`CREATE ROLE app_login LOGIN BYPASSRLS PASSWORD 'app_login'`);
    // Unsafe pre-existing audit_maintenance membership: the migration must revoke it.
    await admin.query(`CREATE ROLE audit_maintenance NOLOGIN`);
    await admin.query(`GRANT audit_maintenance TO app_login`);
    await admin.query(`CREATE ROLE legacy_ops NOLOGIN`);
    await admin.query(`GRANT audit_maintenance TO legacy_ops`);
  } finally {
    await admin.end();
  }

  return async () => {
    await container.stop();
  };
}
