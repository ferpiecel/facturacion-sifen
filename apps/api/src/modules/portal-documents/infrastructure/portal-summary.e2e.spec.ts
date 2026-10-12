import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, documents, tenants, type DatabaseHandle } from '@sifen/db';
import { eq } from 'drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustodyModule } from '../../custody/custody.module.js';
import { DATABASE, DatabaseModule } from '../../database/database.module.js';
import { portalSessionCookie } from '../../../../test/support/portal-session.js';
import { seedDocuments } from '../../../../test/support/document-seed.js';
import { PortalDocumentsModule } from '../portal-documents.module.js';
import { PORTAL_CLOCK } from '../portal-documents.tokens.js';

const NOW = new Date('2026-03-31T15:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const signed = (hours: number) => ({ signedAt: hoursAgo(hours), signedXml: '<DE/>' });
const issued = (day: string) => ({ issuedAt: new Date(`${day}T12:00:00Z`) });

type SummaryBody = Record<string, unknown> & {
  from: string;
  to: string;
  totals: { count: number };
};

describe('GET /portal/summary (HU-E12-03)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  const cookies: Record<string, string> = {};

  const get = (query: string, cookie?: string) =>
    app.inject({
      method: 'GET',
      url: `/portal/summary${query}`,
      headers: cookie ? { cookie } : {},
    });
  const summary = async (query = '') => {
    const res = await get(query, cookies.owner);
    expect(res.statusCode).toBe(200);
    return res.json<SummaryBody>();
  };

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        CustodyModule,
        PortalDocumentsModule,
      ],
    })
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(PORTAL_CLOCK)
      .useValue(() => NOW)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const [acme, globex] = await handle.db
      .insert(tenants)
      .values([{ name: 'Acme SA' }, { name: 'Globex SA' }])
      .returning();
    const messages = (...codes: string[]) => ({
      sifenMessages: codes.map((code) => ({ code, message: `m${code}` })),
    });
    const acmeDocs = [
      { status: 'approved', ...issued('2026-03-20'), totalAmount: '100000' },
      { status: 'approved', ...issued('2026-03-21'), totalAmount: '20000', documentType: 5 },
      {
        status: 'rejected',
        ...issued('2026-03-22'),
        totalAmount: '30000',
        ...messages('1321', '1005'),
      },
      { status: 'rejected', ...issued('2026-03-23'), totalAmount: '30000', ...messages('1321') },
      { status: 'approved', ...issued('2026-03-24'), totalAmount: '50', currency: 'USD' },
      // Pending: issued long ago, so outside the period, yet on the clock.
      { status: 'signed', ...signed(80) },
      { status: 'queued', ...signed(70) },
      { status: 'submitted', ...signed(10) },
      { status: 'approved', ...issued('2026-01-01') },
      { status: 'approved', ...issued('2026-02-15') },
      // 2026-03-31 23:00 in Asuncion, already 2026-04-01 in UTC.
      { status: 'approved', issuedAt: new Date('2026-04-01T02:00:00Z'), totalAmount: '5000' },
      // Exactly 72 h: the deadline is now, not yet overdue.
      { status: 'submitted', ...signed(72) },
    ];
    await seedDocuments(
      handle.db,
      acme.id,
      acmeDocs.map((d) => d.status),
      (i) => acmeDocs[i],
    );
    // An overdue pending document of another environment than the tenant's current one.
    const [template] = await handle.db
      .select()
      .from(documents)
      .where(eq(documents.tenantId, acme.id))
      .limit(1);
    const switchTo = (environment: 'test' | 'production') =>
      handle.db.update(tenants).set({ environment }).where(eq(tenants.id, acme.id));
    await switchTo('production');
    await handle.db.insert(documents).values({
      ...template,
      id: undefined,
      environment: 'production',
      cdc: '01800695631001001000009912026010111234567891',
      number: 99,
      status: 'signed',
      ...signed(90),
    });
    await switchTo('test');
    await seedDocuments(
      handle.db,
      globex.id,
      ['approved', 'rejected', 'signed'],
      (i) =>
        [issued('2026-03-20'), { ...issued('2026-03-21'), ...messages('9999') }, signed(100)][i],
    );

    cookies.owner = await portalSessionCookie(handle.db, 'owner@example.com', {
      tenantId: acme.id,
      role: 'owner',
    });
    cookies.lector = await portalSessionCookie(handle.db, 'lector@example.com', {
      tenantId: acme.id,
      role: 'lector',
    });
    cookies.noTenant = await portalSessionCookie(handle.db, 'plain@example.com');
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it('answers 401 without a verified session and 403 without an active tenant', async () => {
    expect((await get('')).statusCode).toBe(401);
    expect((await get('', cookies.noTenant)).statusCode).toBe(403);
  });

  it('is private and open to any role', async () => {
    const res = await get('', cookies.lector);

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('summarizes the last 30 days of the tenant, by type and status, other tenants excluded', async () => {
    const body = await summary();

    expect(body.from).toBe('2026-03-02');
    expect(body.to).toBe('2026-03-31');
    expect(body.totals).toEqual({ count: 6, amountPyg: '185000', otherCurrencyCount: 1 });
    expect(body.byType).toEqual([
      { type: 'FE', count: 5, amountPyg: '165000' },
      { type: 'NCE', count: 1, amountPyg: '20000' },
    ]);
    expect(body.byStatus).toEqual([
      { status: 'approved', count: 4, amountPyg: '125000' },
      { status: 'rejected', count: 2, amountPyg: '60000' },
    ]);
    expect(body.previous).toEqual({ count: 1 });
  });

  it('counts the rejections by SIFEN code', async () => {
    expect((await summary()).rejected).toEqual({
      count: 2,
      topCodes: [
        { code: '1321', count: 2 },
        { code: '1005', count: 1 },
      ],
    });
  });

  it('buckets the pending documents against the 72 h clock, outside the period and the environment', async () => {
    expect((await summary()).pending).toEqual({
      count: 4,
      overdue: 1,
      dueSoon: 2,
      // The oldest signing (80 h ago) plus 72 h.
      oldestDeadline: '2026-03-31T07:00:00.000Z',
    });
  });

  it('applies from and to as inclusive Asuncion days', async () => {
    const body = await summary('?from=2026-03-31&to=2026-03-31');

    expect(body.totals.count).toBe(1);
    expect(body.previous).toEqual({ count: 0 });
    expect((await summary('?to=2026-03-20')).totals.count).toBe(1);
  });

  it.each([
    '?from=2026-3-1',
    '?from=2024-13-01',
    '?to=2026-01-32',
    '?to=2026-00-10',
    '?to=2026-02-30',
    '?from=2026-03-10&to=2026-03-09',
    '?from=2025-03-30&to=2026-03-31',
  ])('answers 400 for %s', async (query) => {
    expect((await get(query, cookies.owner)).statusCode).toBe(400);
  });
});
