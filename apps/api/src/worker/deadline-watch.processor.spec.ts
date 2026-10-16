import { randomUUID } from 'node:crypto';
import {
  createPgliteDatabase,
  InvalidTenantIdError,
  tenants,
  webhookDeliveries,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deadlineWarningEventId } from '../modules/webhooks/domain/webhook-document-events.js';
import { seedDocuments, seedWebhookEndpoint } from '../../test/support/document-seed.js';
import {
  DEADLINE_WATCH_QUEUE,
  createDeadlineWatchProcessor,
  deadlineWatchJob,
} from './deadline-watch.processor.js';

const H = 3_600_000;
const NOW = new Date('2026-10-04T12:00:00.000Z');
const signedAgo = (hours: number) => new Date(NOW.getTime() - hours * H);

/** Spec: HU-E6-07. Pending documents get one warning per threshold, once, only for their own tenant. */
describe('deadline watch processor', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
    await seedWebhookEndpoint(handle.db, tenantId);
    await seedWebhookEndpoint(handle.db, otherTenantId);
  });
  afterEach(async () => {
    await handle.close();
  });

  const run = (tenant = tenantId, now = NOW) =>
    createDeadlineWatchProcessor({ db: handle.db, now: () => now })({ data: { tenantId: tenant } });
  const warnings = async () =>
    (await handle.db.select().from(webhookDeliveries)).map((row) => {
      const data = (row.payload as { data: { document_id: string; threshold_hours: number } }).data;
      return { tenant: row.tenantId, doc: data.document_id, threshold: data.threshold_hours };
    });
  /** Seeds one document per [status, hours since signing] pair (once per tenant: fixed establishment). */
  const seed = (tenant: string, specs: readonly (readonly [string, number])[]) =>
    seedDocuments(
      handle.db,
      tenant,
      specs.map(([status]) => status),
      (i) => ({ signedAt: signedAgo(specs[i][1]), signedXml: '<x/>' }),
    );

  it('names its queue and repeats one job per tenant', () => {
    expect(DEADLINE_WATCH_QUEUE).toBe('deadline-watch');
    const job = deadlineWatchJob('t1', 1_000);
    expect(job.data).toEqual({ tenantId: 't1' });
    expect(job.opts.repeat).toEqual({ every: 1_000 });
    expect(job.opts.jobId).toBe('deadline-watch:t1');
  });

  it('warns at exactly 48 h and at exactly 66 h, not before', async () => {
    const [early, at48, at66] = await seed(tenantId, [
      ['signed', 47.9],
      ['queued', 48],
      ['submitted', 66],
    ]);
    await run();
    const found = (await warnings()).map(
      (w) => `${w.doc === at48.id ? '48' : w.doc === at66.id ? '66' : '?'}:${String(w.threshold)}`,
    );
    expect(found.sort()).toEqual(['48:48', '66:48', '66:66']);
    expect((await warnings()).some((w) => w.doc === early.id)).toBe(false);
  });

  it('carries the document, the CDC, the deadline and the hours remaining', async () => {
    const [doc] = await seed(tenantId, [['signed', 66]]);
    await run();
    const row = (await handle.db.select().from(webhookDeliveries)).find(
      (r) => r.eventId === deadlineWarningEventId(doc.id, 66),
    );
    expect(row).toBeDefined();
    expect(row?.eventType).toBe('document.transmission_deadline_warning');
    expect(row?.payload).toMatchObject({
      type: 'document.transmission_deadline_warning',
      tenant_id: tenantId,
      data: {
        document_id: doc.id,
        cdc: doc.cdc,
        threshold_hours: 66,
        transmission_deadline: '2026-10-04T18:00:00.000Z',
        hours_remaining: 6,
      },
    });
  });

  it('sends each threshold once however many runs and restarts happen', async () => {
    await seed(tenantId, [['signed', 70]]);
    await run();
    await run(tenantId, new Date(NOW.getTime() + 10 * 60_000));
    await run();
    expect((await warnings()).map((w) => w.threshold).sort()).toEqual([48, 66]);
  });

  it('ignores settled documents and documents already past the 72 h window', async () => {
    await seed(tenantId, [
      ['approved', 70],
      ['approved_with_observations', 70],
      ['rejected', 70],
      ['cancelled', 70],
      ['signed', 73],
    ]);
    await run();
    expect(await warnings()).toEqual([]);
  });

  it('only looks at the job tenant', async () => {
    await seed(tenantId, [['signed', 70]]);
    await seed(otherTenantId, [['signed', 70]]);
    await run(otherTenantId);
    expect((await warnings()).map((w) => w.tenant)).toEqual([otherTenantId, otherTenantId]);
  });

  it('rejects a job whose tenant id is not a UUID before any query', async () => {
    await expect(run("x'; drop table documents; --")).rejects.toBeInstanceOf(InvalidTenantIdError);
    await expect(run(randomUUID())).resolves.toEqual({ warned: 0 });
  });
});
