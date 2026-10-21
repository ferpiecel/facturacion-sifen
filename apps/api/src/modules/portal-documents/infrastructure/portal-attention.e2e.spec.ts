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

interface Body {
  items: { cdc: string; status: string; reasons: string[]; rejectionReason: string | null }[];
  total: number;
  truncated: boolean;
}

describe('GET /portal/attention (HU-E12-04)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  const cookies: Record<string, string> = {};
  const cdcOf: Record<string, string> = {};

  const get = (cookie?: string) =>
    app.inject({ method: 'GET', url: '/portal/attention', headers: cookie ? { cookie } : {} });

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
    const acmeDocs: [string, Partial<typeof documents.$inferInsert>][] = [
      ['overdue', { status: 'signed', ...signed(80) }],
      ['due-soon', { status: 'queued', ...signed(66) }],
      ['on-time', { status: 'submitted', ...signed(10) }],
      [
        'rejected',
        {
          status: 'rejected',
          ...signed(5),
          sifenMessages: [{ code: '1321', message: 'RUC inexistente' }],
        },
      ],
      ['held', { status: 'accepted', transmissionHold: 'signing:SigningDataIncompleteError' }],
      ['approved', { status: 'approved', ...signed(100) }],
      ['corrected', { status: 'corrected', ...signed(100) }],
    ];
    const seeded = await seedDocuments(
      handle.db,
      acme.id,
      acmeDocs.map(([, d]) => d.status as string),
      (i) => acmeDocs[i][1],
    );
    for (const [i, [name]] of acmeDocs.entries()) cdcOf[name] = seeded[i].cdc;
    // An overdue document of another environment than the tenant's current one stays out.
    const [template] = await handle.db
      .select()
      .from(documents)
      .where(eq(documents.tenantId, acme.id))
      .limit(1);
    await handle.db
      .update(tenants)
      .set({ environment: 'production' })
      .where(eq(tenants.id, acme.id));
    await handle.db.insert(documents).values({
      ...template,
      id: undefined,
      environment: 'production',
      cdc: '01800695631001001000009912026010111234567891',
      number: 99,
      status: 'signed',
      ...signed(90),
    });
    await handle.db.update(tenants).set({ environment: 'test' }).where(eq(tenants.id, acme.id));
    await seedDocuments(handle.db, globex.id, ['signed'], () => signed(100));

    // 100 old rejected documents must not crowd out the more urgent ones when the list is cut.
    const [initech] = await handle.db.insert(tenants).values({ name: 'Initech SA' }).returning();
    const [seed] = await seedDocuments(handle.db, initech.id, ['signed'], () => signed(80));
    const [base] = await handle.db.select().from(documents).where(eq(documents.id, seed.id));
    cdcOf.crowdedOverdue = seed.cdc;
    const [heldRow] = await handle.db
      .insert(documents)
      .values({
        ...base,
        id: undefined,
        cdc: '0180069563100100100' + '00500' + '12026010111234567891',
        number: 500,
        status: 'accepted',
        signedAt: null,
        signedXml: null,
        transmissionHold: 'signing:SigningDataIncompleteError',
      })
      .returning();
    cdcOf.crowdedHeld = heldRow.cdc;
    const [soonRow] = await handle.db
      .insert(documents)
      .values({
        ...base,
        id: undefined,
        cdc: '0180069563100100100' + '00700' + '12026010111234567891',
        number: 700,
        status: 'queued',
        ...signed(66),
      })
      .returning();
    cdcOf.crowdedDueSoon = soonRow.cdc;
    await handle.db.insert(documents).values(
      Array.from({ length: 100 }, (_, n) => ({
        ...base,
        id: undefined,
        cdc: '0180069563100100100' + String(600 + n).padStart(5, '0') + '12026010111234567891',
        number: 600 + n,
        status: 'rejected',
        ...signed(200 + n),
      })),
    );
    cookies.initech = await portalSessionCookie(handle.db, 'owner@initech.example', {
      tenantId: initech.id,
      role: 'owner',
    });

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
    expect((await get()).statusCode).toBe(401);
    expect((await get(cookies.noTenant)).statusCode).toBe(403);
  });

  it('is private and open to any role', async () => {
    const res = await get(cookies.lector);

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('lists only the active tenant and environment documents that need action, most urgent first', async () => {
    const body = (await get(cookies.owner)).json<Body>();

    expect(body.items.map((i) => [i.cdc, i.reasons])).toEqual([
      [cdcOf.overdue, ['overdue']],
      [cdcOf.held, ['held']],
      [cdcOf['due-soon'], ['due_soon']],
      [cdcOf.rejected, ['rejected']],
    ]);
    expect(body).toMatchObject({ total: 4, truncated: false });
    expect(body.items[3].rejectionReason).toBe('RUC inexistente');
  });

  it('keeps the most urgent documents when the list is cut at 100', async () => {
    const body = (await get(cookies.initech)).json<Body>();

    expect(body.items).toHaveLength(100);
    expect(body.items.map((i) => i.cdc).slice(0, 3)).toEqual([
      cdcOf.crowdedOverdue,
      cdcOf.crowdedHeld,
      cdcOf.crowdedDueSoon,
    ]);
    expect(body).toMatchObject({ total: 103, truncated: true });
  });
});
