import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createNodePostgresDatabase,
  documents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import {
  createAcceptCreditNote,
  type AcceptCreditNoteInput,
} from '../application/accept-credit-note.js';
import { InvoiceValidationError } from '../application/accept-invoice.js';
import type {
  AcceptanceUnit,
  AcceptanceUnitOfWork,
} from '../application/ports/acceptance-unit-of-work.port.js';
import {
  acceptInvoiceWithStatus,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';

const REAL_POSTGRES = process.env.DB_TEST_DRIVER === 'postgres';

interface Latch {
  promise: Promise<void>;
  open: () => void;
}
const latch = (): Latch => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/**
 * Spec: HU-E7-01 (ADR-0019 D5). Two real connections race for the same FE, which PGlite (one
 * connection) cannot show: it proves `FOR NO KEY UPDATE` really serializes the credit sum.
 * Runs only with `DB_TEST_DRIVER=postgres` (`pnpm --filter @sifen/api test:postgres`, Docker).
 */
describe.skipIf(!REAL_POSTGRES)('credit note race on a real PostgreSQL', () => {
  let stop: () => Promise<void> = () => Promise.resolve();
  let baseUrl = '';
  let handle: DatabaseHandle;
  let tenantId: string;
  let feCdc: string;

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
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    tenantId = tenant.id;
    await seedIssuer(handle.db, tenantId);
    feCdc = (await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-1')).cdc;
  }, 120_000);

  const input = (unitPrice: number, key: string): AcceptCreditNoteInput => {
    const draft = {
      associatedCdc: feCdc,
      reasonCode: 2,
      items: [{ quantity: 1, unitPrice, vatRate: 10 as const }],
      roundingPyg: 0,
    };
    return {
      tenantId,
      actor: { type: 'api_key', id: 'k' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: { type: 'NCE', ...draft },
      idempotencyKey: key,
    };
  };

  /** The real unit of work, except that the first transaction to lock the FE is held there until released. */
  function gatedUnitOfWork(heldAfterLock: Latch, locked: Latch): AcceptanceUnitOfWork {
    const real = createDrizzleAcceptanceUnitOfWork(handle.db);
    let first = true;
    return {
      run: (tenant, work) =>
        real.run(tenant, (unit) => {
          const gated: AcceptanceUnit = {
            ...unit,
            async findAssociatedInvoice(cdc, environment) {
              const invoice = await unit.findAssociatedInvoice(cdc, environment);
              if (first) {
                first = false;
                locked.open();
                await heldAfterLock.promise;
              }
              return invoice;
            },
          };
          return work(gated);
        }),
    };
  }

  /** Whether a backend is waiting for the FE row lock right now. */
  async function someoneWaitsForTheLock(): Promise<boolean> {
    const result = await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%for no key update%'`,
    );
    return (result as { rows: { n: number }[] }).rows[0].n > 0;
  }

  async function eventually(check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('condition not reached in 5 s');
  }

  const credits = () =>
    withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents)).then((rows) =>
      rows.filter((r) => r.documentType === 5),
    );

  it('makes the second credit wait for the first, then refuse it with 2417', async () => {
    const heldAfterLock = latch();
    const locked = latch();
    const accept = createAcceptCreditNote({ unitOfWork: gatedUnitOfWork(heldAfterLock, locked) });

    const a = accept(input(600_000, 'nce-a'));
    await locked.promise;
    const b = accept(input(600_000, 'nce-b')).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await eventually(someoneWaitsForTheLock);
    heldAfterLock.open();

    await expect(a).resolves.toBeDefined();
    const outcome = await b;
    expect('error' in outcome && outcome.error).toBeInstanceOf(InvoiceValidationError);
    expect((outcome as { error: InvoiceValidationError }).error.errors.map((e) => e.rule)).toEqual([
      'credit-note-sum-exceeds-invoice',
    ]);
    const stored = await credits();
    expect(stored.map((r) => r.number)).toEqual([1]);
  });

  it('replays the same key and body instead of failing with 2417', async () => {
    const heldAfterLock = latch();
    const locked = latch();
    const accept = createAcceptCreditNote({ unitOfWork: gatedUnitOfWork(heldAfterLock, locked) });

    const a = accept(input(600_000, 'nce-same'));
    await locked.promise;
    const b = accept(input(600_000, 'nce-same'));
    await eventually(someoneWaitsForTheLock);
    heldAfterLock.open();

    const [first, second] = await Promise.all([a, b]);
    expect(second).toEqual(first);
    expect(await credits()).toHaveLength(1);
  });
});
