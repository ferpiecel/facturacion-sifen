import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createNodePostgresDatabase,
  documents,
  issuerEvents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { createDrizzleEventRecoveryStore } from './drizzle-event-recovery-store.js';

const REAL_POSTGRES = process.env.DB_TEST_DRIVER === 'postgres';
const cdcOf = (n: number) =>
  `0180069563100100100000${String(n).padStart(2, '0')}12026010111234567891`;

/**
 * Spec: HU-E8-04 hardening. Concurrent workers over the same tenant must never query the same unknown
 * cancellation: a claim needs real connections, which PGlite (one connection) cannot show. Runs only with
 * `DB_TEST_DRIVER=postgres` (`pnpm --filter @sifen/api test:postgres`, Docker).
 */
describe.skipIf(!REAL_POSTGRES)('event recovery claim on a real PostgreSQL', () => {
  let stop: () => Promise<void> = () => Promise.resolve();
  let baseUrl = '';
  let handle: DatabaseHandle;
  let tenantId: string;
  let ids: string[];

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
    const name = `claim_${randomUUID().replaceAll('-', '')}`;
    await admin.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
    await admin.close();
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    handle = createNodePostgresDatabase(url.toString());
    await handle.migrate();
    const { db } = handle;
    const [tenant] = await db.insert(tenants).values({ name: 'A' }).returning();
    tenantId = tenant.id;
    const [est] = await db
      .insert(tenantEstablishments)
      .values({
        tenantId,
        code: '001',
        address: 'Av. Mariscal Lopez 123',
        houseNumber: '123',
        departmentCode: '11',
        districtCode: '145',
        districtDescription: 'Asuncion',
        cityCode: '3432',
        cityDescription: 'Asuncion',
      })
      .returning();
    const [point] = await db
      .insert(tenantExpeditionPoints)
      .values({ tenantId, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await db
      .insert(tenantTimbrados)
      .values({ tenantId, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    ids = [];
    for (let n = 1; n <= 6; n += 1) {
      const [document] = await db
        .insert(documents)
        .values({
          tenantId,
          environment: 'test',
          timbradoId: timbrado.id,
          establishmentId: est.id,
          expeditionPointId: point.id,
          documentType: 1,
          number: n,
          cdc: cdcOf(n),
          securityCode: '123456789',
          issuedAt: new Date(),
          totalAmount: '110000',
          payload: { items: [] },
        })
        .returning();
      const [row] = await db
        .insert(issuerEvents)
        .values({
          tenantId,
          environment: 'test',
          kind: 'cancellation',
          eventId: BigInt(n),
          documentId: document.id,
          reason: 'Error en los datos',
        })
        .returning();
      await db
        .update(issuerEvents)
        .set({ status: 'signed', signedXml: '<a/>', signedAt: new Date() })
        .where(eq(issuerEvents.id, row.id));
      await db
        .update(issuerEvents)
        .set({ status: 'sending', batchDId: 5n, sendAttemptedAt: new Date(Date.now() - 3_600_000) })
        .where(eq(issuerEvents.id, row.id));
      await db.update(issuerEvents).set({ status: 'unknown' }).where(eq(issuerEvents.id, row.id));
      ids.push(row.id);
    }
    // Let the events age past the claim lease (the guard trigger would stamp updated_at with now()).
    await db.execute(sql`ALTER TABLE issuer_events DISABLE TRIGGER issuer_events_guard`);
    await db.execute(sql`UPDATE issuer_events SET updated_at = now() - interval '1 hour'`);
    await db.execute(sql`ALTER TABLE issuer_events ENABLE TRIGGER issuer_events_guard`);
  }, 120_000);

  it('hands each unknown cancellation to exactly one of several concurrent workers', async () => {
    const workers = [1, 2, 3].map(() =>
      createDrizzleEventRecoveryStore({ db: handle.db, tenantId, claimLeaseMs: 5 * 60_000 }),
    );

    const claims = await Promise.all(
      workers.map((worker) => worker.unresolvedCancellations(new Date(), 6)),
    );

    const claimed = claims.flat().map((event) => event.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual([...ids].sort());
  });
});
