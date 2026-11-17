import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createNodePostgresDatabase,
  receptionExtractionUsage,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { createDrizzleExtractionUsageStore } from './drizzle-extraction-usage-store.js';

const REAL_POSTGRES = process.env.DB_TEST_DRIVER === 'postgres';
const DAY = '2026-11-17';

/**
 * Spec: R5.9. Concurrent callers race for the daily extraction counter on separate real
 * connections, which PGlite (one connection) cannot show: it proves the single-statement upsert
 * `ON CONFLICT DO UPDATE ... WHERE used < cap` serializes on the row and never passes the cap.
 * Runs only with `DB_TEST_DRIVER=postgres` (`pnpm --filter @sifen/api test:postgres`, Docker).
 */
describe.skipIf(!REAL_POSTGRES)('extraction usage counter race on a real PostgreSQL', () => {
  let stop: () => Promise<void> = () => Promise.resolve();
  let baseUrl = '';
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import('testcontainers');
    const container = await new GenericContainer('postgres:16')
      .withEnvironment({ POSTGRES_USER: 'sifen', POSTGRES_PASSWORD: 'sifen', POSTGRES_DB: 'sifen' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    stop = () => container.stop().then(() => undefined);
    baseUrl = `postgres://sifen:sifen@${container.getHost()}:${container.getMappedPort(5432).toString()}/sifen`;
  }, 120_000);

  afterAll(async () => {
    await stop();
  });

  afterEach(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    const admin = createNodePostgresDatabase(baseUrl);
    const name = `race_${randomUUID().replaceAll('-', '')}`;
    await admin.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
    await admin.close();
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    handle = createNodePostgresDatabase(url.toString());
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantA = a.id;
    tenantB = b.id;
  }, 120_000);

  const used = (tenantId: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(receptionExtractionUsage),
    ).then((rows) => rows.map((r) => r.used));

  const race = (tenantId: string, calls: number, cap: number) => {
    const store = createDrizzleExtractionUsageStore(handle.db);
    return Promise.all(Array.from({ length: calls }, () => store.tryConsume(tenantId, DAY, cap)));
  };

  it('lets exactly cap callers through out of ten concurrent ones', async () => {
    const results = await race(tenantA, 10, 3);

    expect(results.filter((r) => r !== null)).toHaveLength(3);
    expect(results.filter((r) => r === null)).toHaveLength(7);
    expect([...results].filter((r) => r !== null).sort()).toEqual([1, 2, 3]);
    expect(await used(tenantA)).toEqual([3]);
  });

  it('lets exactly one of two concurrent callers win the last slot', async () => {
    const results = await race(tenantA, 2, 1);

    expect(results.filter((r) => r !== null)).toEqual([1]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(await used(tenantA)).toEqual([1]);
  });

  it('keeps the counters of two tenants independent when they race together', async () => {
    const [a, b] = await Promise.all([race(tenantA, 5, 2), race(tenantB, 5, 4)]);

    expect(a.filter((r) => r !== null)).toHaveLength(2);
    expect(b.filter((r) => r !== null)).toHaveLength(4);
    expect(await used(tenantA)).toEqual([2]);
    expect(await used(tenantB)).toEqual([4]);
  });
});
