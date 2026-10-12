import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDocuments } from '../../../../test/support/document-seed.js';
import { portalSessionCookie } from '../../../../test/support/portal-session.js';
import { signedInvoiceWithQr } from '../../../../test/support/signed-invoice.js';
import { CustodyModule } from '../../custody/custody.module.js';
import { DATABASE, DatabaseModule } from '../../database/database.module.js';
import { PortalDocumentsModule } from '../portal-documents.module.js';

describe('GET /portal/documents/:id/xml and /kude (HU-E12-02)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let xml: string;
  let cookie: string;
  let noTenant: string;
  let cdc: string;
  const ids: Record<string, string> = {};

  const get = (path: string, withCookie: string | undefined = cookie) =>
    app.inject({
      method: 'GET',
      url: `/portal/documents/${path}`,
      headers: withCookie ? { cookie: withCookie } : {},
    });

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    xml = await signedInvoiceWithQr();
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
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const [acme, globex] = await handle.db
      .insert(tenants)
      .values([{ name: 'Acme SA' }, { name: 'Globex SA' }])
      .returning();
    const signed = () => ({ signedXml: xml, signedAt: new Date('2026-01-01T12:00:05Z') });
    const rows = await seedDocuments(handle.db, acme.id, ['approved', 'accepted'], (i) =>
      i === 0 ? signed() : {},
    );
    [ids.signed, ids.unsigned] = rows.map((r) => r.id);
    cdc = rows[0].cdc;
    [ids.foreign] = (await seedDocuments(handle.db, globex.id, ['approved'], signed)).map(
      (r) => r.id,
    );
    cookie = await portalSessionCookie(handle.db, 'lector@example.com', {
      tenantId: acme.id,
      role: 'lector',
    });
    noTenant = await portalSessionCookie(handle.db, 'plain@example.com');
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it.each(['', '/xml', '/kude'])(
    'answers 401 without a session and 403 without a tenant (%j)',
    async (suffix) => {
      expect((await get(`${ids.signed}${suffix}`, '')).statusCode).toBe(401);
      expect((await get(`${ids.signed}${suffix}`, noTenant)).statusCode).toBe(403);
    },
  );

  it('answers 404 for another tenant, an unknown and a malformed id', async () => {
    for (const id of [ids.foreign, crypto.randomUUID(), 'not-a-uuid']) {
      for (const suffix of ['/xml', '/kude']) {
        expect((await get(`${id}${suffix}`)).statusCode, `${id}${suffix}`).toBe(404);
      }
    }
  });

  it('downloads the signed XML as an attachment', async () => {
    const res = await get(`${ids.signed}/xml`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${cdc}.xml"`);
    expect(res.payload).toBe(xml);
  });

  it('answers 404 for the XML of an unsigned document', async () => {
    expect((await get(`${ids.unsigned}/xml`)).statusCode).toBe(404);
  });

  it('renders the KuDE PDF of a signed document and 409 while it is unsigned', async () => {
    const res = await get(`${ids.signed}/kude`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="kude-001-001-0000001.pdf"');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await get(`${ids.unsigned}/kude`)).statusCode).toBe(409);
  });
});
