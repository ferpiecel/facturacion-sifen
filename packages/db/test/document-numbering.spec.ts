import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import {
  InvalidDocumentTypeError,
  MAX_DOCUMENT_NUMBER,
  nextDocumentNumber as nextSequenceValue,
  type DocumentSequenceKey,
} from '../src/document-number.js';
import { SeriesExhaustedError } from '../src/series.js';
import {
  tenantDocumentSequences,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
} from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

type Tx = Parameters<typeof nextSequenceValue>[0];

/** The dNumDoc alone (the series-aware result is asserted in the HU-E4-02 tests). */
async function nextDocumentNumber(tx: Tx, key: DocumentSequenceKey): Promise<number> {
  return (await nextSequenceValue(tx, key)).number;
}

async function causeMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E4-01. `dNumDoc` (MT v150, 7 digits) assigned atomically per sequence key. */
describe('nextDocumentNumber (dNumDoc numbering)', () => {
  let handle: DatabaseHandle | undefined;

  async function seed() {
    const testHandle = await createTestDatabase();
    handle = testHandle;
    const { db } = testHandle;

    const [a, b] = await db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }])
      .returning();
    const tenantA = a.id;
    const tenantB = b.id;

    async function fiscalSetup(tenantId: string) {
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
      const establishmentId = est.id;
      const points = await db
        .insert(tenantExpeditionPoints)
        .values([
          { tenantId, establishmentId, code: '001' },
          { tenantId, establishmentId, code: '002' },
        ])
        .returning();
      const [tim] = await db
        .insert(tenantTimbrados)
        .values({ tenantId, number: '12345678', validFrom: '2024-01-01' })
        .returning();
      const key: DocumentSequenceKey = {
        tenantId,
        environment: 'test',
        timbradoId: tim.id,
        establishmentId,
        expeditionPointId: points[0].id,
        documentType: 1,
      };
      return { key, secondPointId: points[1].id };
    }

    const setupA = await fiscalSetup(tenantA);
    const setupB = await fiscalSetup(tenantB);
    return {
      db,
      tenantA,
      tenantB,
      keyA: setupA.key,
      secondPointA: setupA.secondPointId,
      keyB: setupB.key,
    };
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('starts at 1 and increments sequentially', async () => {
    const { db, keyA } = await seed();

    const numbers: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      numbers.push(
        await withTenantTransaction(db, keyA.tenantId, (tx) => nextDocumentNumber(tx, keyA)),
      );
    }

    expect(numbers).toEqual([1, 2, 3]);
  });

  it('keeps an independent sequence per key component', async () => {
    const { db, keyA, secondPointA } = await seed();
    const next = (key: DocumentSequenceKey) =>
      withTenantTransaction(db, key.tenantId, (tx) => nextDocumentNumber(tx, key));

    expect(await next(keyA)).toBe(1);
    expect(await next(keyA)).toBe(2);
    expect(await next({ ...keyA, documentType: 5 })).toBe(1);
    expect(await next({ ...keyA, expeditionPointId: secondPointA })).toBe(1);
    expect(await next(keyA)).toBe(3);
  });

  it('does not burn a number when the transaction rolls back', async () => {
    const { db, keyA } = await seed();

    await expect(
      withTenantTransaction(db, keyA.tenantId, async (tx) => {
        expect(await nextDocumentNumber(tx, keyA)).toBe(1);
        throw new Error('emission failed');
      }),
    ).rejects.toThrow('emission failed');

    expect(
      await withTenantTransaction(db, keyA.tenantId, (tx) => nextDocumentNumber(tx, keyA)),
    ).toBe(1);
  });

  it('refuses to go past 9999999 of series ZZ with a typed error and leaves the counter intact', async () => {
    const { db, keyA } = await seed();
    await db
      .insert(tenantDocumentSequences)
      .values({ ...keyA, series: 'ZZ', lastNumber: MAX_DOCUMENT_NUMBER - 1 });
    const next = () =>
      withTenantTransaction(db, keyA.tenantId, (tx) => nextDocumentNumber(tx, keyA));

    expect(await next()).toBe(MAX_DOCUMENT_NUMBER);
    await expect(next()).rejects.toBeInstanceOf(SeriesExhaustedError);

    const rows = await db.select().from(tenantDocumentSequences);
    expect(rows.map((row) => [row.series, row.lastNumber])).toEqual([['ZZ', MAX_DOCUMENT_NUMBER]]);
  });

  /** Spec: HU-E4-02 (rule 1110). Move to the next series when 9999999 is exhausted. */
  describe('series rollover', () => {
    const next = (db: DatabaseHandle['db'], key: DocumentSequenceKey) =>
      withTenantTransaction(db, key.tenantId, (tx) => nextSequenceValue(tx, key));

    it('issues no series at first, then opens AA at number 1 after 9999999', async () => {
      const { db, keyA } = await seed();
      await db
        .insert(tenantDocumentSequences)
        .values({ ...keyA, lastNumber: MAX_DOCUMENT_NUMBER - 1 });

      expect(await next(db, keyA)).toEqual({ series: null, number: MAX_DOCUMENT_NUMBER });
      expect(await next(db, keyA)).toEqual({ series: 'AA', number: 1 });
      expect(await next(db, keyA)).toEqual({ series: 'AA', number: 2 });
    });

    it('carries AZ over to BA and keeps every series row', async () => {
      const { db, keyA } = await seed();
      await db
        .insert(tenantDocumentSequences)
        .values({ ...keyA, series: 'AZ', lastNumber: MAX_DOCUMENT_NUMBER });

      expect(await next(db, keyA)).toEqual({ series: 'BA', number: 1 });
      const rows = await db.select().from(tenantDocumentSequences);
      expect(rows.map((row) => row.series).sort()).toEqual(['AZ', 'BA']);
    });

    it('records the start date of each series', async () => {
      const { db, keyA } = await seed();
      await db.insert(tenantDocumentSequences).values({ ...keyA, lastNumber: MAX_DOCUMENT_NUMBER });
      const before = Date.now();

      await next(db, keyA);

      const rows = await db.select().from(tenantDocumentSequences);
      const opened = rows.find((row) => row.series === 'AA');
      expect(opened?.seriesStartedAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
      expect(opened?.seriesStartedAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    });

    it('keeps series independent per sequence key', async () => {
      const { db, keyA, secondPointA } = await seed();
      await db.insert(tenantDocumentSequences).values({ ...keyA, lastNumber: MAX_DOCUMENT_NUMBER });

      expect(await next(db, keyA)).toEqual({ series: 'AA', number: 1 });
      expect(await next(db, { ...keyA, expeditionPointId: secondPointA })).toEqual({
        series: null,
        number: 1,
      });
    });

    it('rejects malformed series at the table level (no Ñ, two uppercase letters)', async () => {
      const { db, keyA } = await seed();
      for (const series of ['ÑA', 'aa', 'A', 'AAA']) {
        expect(
          await causeMessage(db.insert(tenantDocumentSequences).values({ ...keyA, series })),
        ).toContain('tenant_document_sequences_series_format');
      }
    });

    it.skipIf(process.env.DB_TEST_DRIVER !== 'postgres')(
      'gives 9999999 to one caller and series AA number 1 to the other at the boundary (needs real Postgres)',
      async () => {
        const { db, keyA } = await seed();
        await db
          .insert(tenantDocumentSequences)
          .values({ ...keyA, lastNumber: MAX_DOCUMENT_NUMBER - 1 });

        const results = await Promise.all([next(db, keyA), next(db, keyA)]);

        expect(results).toContainEqual({ series: null, number: MAX_DOCUMENT_NUMBER });
        expect(results).toContainEqual({ series: 'AA', number: 1 });
      },
    );

    it.skipIf(process.env.DB_TEST_DRIVER !== 'postgres')(
      'never duplicates a (series, number) pair with many callers straddling the rollover',
      async () => {
        const { db, keyA } = await seed();
        await db
          .insert(tenantDocumentSequences)
          .values({ ...keyA, lastNumber: MAX_DOCUMENT_NUMBER - 3 });

        const results = await Promise.all(Array.from({ length: 10 }, () => next(db, keyA)));

        const pairs = results.map((r) => `${r.series ?? '-'}:${String(r.number)}`).sort();
        expect(new Set(pairs).size).toBe(10);
        expect(results.filter((r) => r.series === null)).toHaveLength(3);
        expect(
          results
            .filter((r) => r.series === 'AA')
            .map((r) => r.number)
            .sort((a, b) => a - b),
        ).toEqual([1, 2, 3, 4, 5, 6, 7]);
      },
    );
  });

  it('isolates tenants: RLS hides and blocks other tenants sequences', async () => {
    const { db, tenantA, tenantB, keyA, keyB } = await seed();
    await withTenantTransaction(db, tenantA, (tx) => nextDocumentNumber(tx, keyA));
    await withTenantTransaction(db, tenantB, (tx) => nextDocumentNumber(tx, keyB));
    await withTenantTransaction(db, tenantB, (tx) => nextDocumentNumber(tx, keyB));

    const seenByA = await withTenantTransaction(db, tenantA, (tx) =>
      tx.select().from(tenantDocumentSequences),
    );
    expect(seenByA.map((row) => [row.tenantId, row.lastNumber])).toEqual([[tenantA, 1]]);

    const updated = await withTenantTransaction(db, tenantA, (tx) =>
      tx
        .update(tenantDocumentSequences)
        .set({ lastNumber: 0 })
        .where(eq(tenantDocumentSequences.tenantId, tenantB))
        .returning(),
    );
    expect(updated).toEqual([]);

    const message = await causeMessage(
      withTenantTransaction(db, tenantA, (tx) => nextDocumentNumber(tx, keyB)),
    );
    expect(message).toContain('row-level security policy');
    expect(message).toContain('tenant_document_sequences');
  });

  it('enforces the table constraints by name', async () => {
    const { db, keyA } = await seed();
    const insert = (values: Partial<typeof tenantDocumentSequences.$inferInsert>) =>
      db.insert(tenantDocumentSequences).values({ ...keyA, ...values });

    expect(await causeMessage(insert({ lastNumber: -1 }))).toContain(
      'tenant_document_sequences_last_number_range',
    );
    expect(await causeMessage(insert({ lastNumber: MAX_DOCUMENT_NUMBER + 1 }))).toContain(
      'tenant_document_sequences_last_number_range',
    );
    expect(await causeMessage(insert({ environment: 'staging' as 'test' }))).toContain(
      'tenant_environment',
    );
    expect(await causeMessage(insert({ documentType: 0 }))).toContain(
      'tenant_document_sequences_document_type_range',
    );
    expect(await causeMessage(insert({ documentType: 9 }))).toContain(
      'tenant_document_sequences_document_type_range',
    );
    expect(await causeMessage(insert({ environment: 'production' }))).toContain(
      "environment must match the tenant's current environment",
    );
    expect(
      await causeMessage(insert({ timbradoId: '00000000-0000-4000-8000-000000000000' })),
    ).toContain('tenant_document_sequences_tenant_timbrado_fk');
    expect(
      await causeMessage(insert({ expeditionPointId: '00000000-0000-4000-8000-000000000000' })),
    ).toContain('tenant_document_sequences_tenant_point_fk');

    await insert({});
    expect(await causeMessage(insert({}))).toContain('tenant_document_sequences_pkey');
  });

  it('rejects an out-of-range document type with a typed error before hitting the DB', async () => {
    const { db, keyA } = await seed();

    for (const documentType of [0, 9, 1.5]) {
      await expect(
        withTenantTransaction(db, keyA.tenantId, (tx) =>
          nextDocumentNumber(tx, { ...keyA, documentType }),
        ),
      ).rejects.toBeInstanceOf(InvalidDocumentTypeError);
    }
  });

  it('rejects tenant-role attempts to rewind or change the counter, and to delete it', async () => {
    const { db, keyA } = await seed();
    const next = () =>
      withTenantTransaction(db, keyA.tenantId, (tx) => nextDocumentNumber(tx, keyA));
    await next();
    await next();
    const update = (set: Partial<typeof tenantDocumentSequences.$inferInsert>) =>
      causeMessage(
        withTenantTransaction(db, keyA.tenantId, (tx) =>
          tx.update(tenantDocumentSequences).set(set),
        ),
      );

    for (const lastNumber of [0, 1, 2, 4]) {
      expect(await update({ lastNumber })).toContain('last_number may only advance by 1');
    }
    expect(await update({ documentType: 2 })).toContain('key columns are immutable');
    expect(
      await causeMessage(
        withTenantTransaction(db, keyA.tenantId, (tx) => tx.delete(tenantDocumentSequences)),
      ),
    ).toContain('permission denied');

    expect(await next()).toBe(3);
  });

  it('follows a tenant switched from test to production, keeping old test sequences', async () => {
    const { db, keyA } = await seed();
    const next = (key: DocumentSequenceKey) =>
      withTenantTransaction(db, key.tenantId, (tx) => nextDocumentNumber(tx, key));
    expect(await next(keyA)).toBe(1);

    await db
      .update(tenants)
      .set({ environment: 'production' })
      .where(eq(tenants.id, keyA.tenantId));

    const productionKey = { ...keyA, environment: 'production' as const };
    expect(await next(productionKey)).toBe(1);
    expect(await next(productionKey)).toBe(2);
    expect(await causeMessage(next(keyA))).toContain(
      "environment must match the tenant's current environment",
    );
    const rows = await db.select().from(tenantDocumentSequences);
    expect(rows.map((row) => [row.environment, row.lastNumber]).sort()).toEqual([
      ['production', 2],
      ['test', 1],
    ]);
  });

  it.skipIf(process.env.DB_TEST_DRIVER !== 'postgres')(
    'assigns exactly 1..100 with no gaps or duplicates across 100 parallel emissions (needs real Postgres: PGlite is single-connection; effective concurrency is the default pg Pool size, 10)',
    async () => {
      const { db, keyA } = await seed();

      const numbers = await Promise.all(
        Array.from({ length: 100 }, () =>
          withTenantTransaction(db, keyA.tenantId, (tx) => nextDocumentNumber(tx, keyA)),
        ),
      );

      expect([...numbers].sort((x, y) => x - y)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
    },
  );

  it.skipIf(process.env.DB_TEST_DRIVER !== 'postgres')(
    'keeps committed numbers exactly 1..N when some parallel emissions roll back (effective concurrency: default pg Pool size, 10)',
    async () => {
      const { db, keyA } = await seed();

      const results = await Promise.allSettled(
        Array.from({ length: 60 }, (_, i) =>
          withTenantTransaction(db, keyA.tenantId, async (tx) => {
            const number = await nextDocumentNumber(tx, keyA);
            if (i % 3 === 0) {
              throw new Error('emission failed');
            }
            return number;
          }),
        ),
      );

      const committed = results
        .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((x, y) => x - y);
      expect(committed).toHaveLength(40);
      expect(committed).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    },
  );
});
