import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  tenantMemberships,
  tenants,
  users,
  type DatabaseHandle,
} from '@sifen/db';
import { sql } from 'drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDocuments } from '../../../../test/support/document-seed.js';
import { generateSessionToken, hashSessionToken } from '../../identity/domain/session-token.js';
import { COOKIE_NAMES } from '../../identity/infrastructure/http/auth-cookies.js';
import { CustodyModule } from '../../custody/custody.module.js';
import { DATABASE, DatabaseModule } from '../../database/database.module.js';
import { PortalDocumentsModule } from '../portal-documents.module.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA';

describe('GET /portal/documents/:id (HU-E12-02)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let cookie: string;
  const ids: Record<string, string> = {};
  let cdc: string;

  async function session(email: string, tenantId?: string): Promise<string> {
    const [user] = await handle.db
      .insert(users)
      .values({ email, passwordHash: HASH, displayName: email })
      .returning();
    if (tenantId)
      await handle.db
        .insert(tenantMemberships)
        .values({ tenantId, userId: user.id, role: 'lector' });
    const token = generateSessionToken();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await handle.db.execute(sql`insert into user_sessions
      (user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, absolute_expires_at, mfa_verified_at, active_tenant_id)
      values (${user.id}, gen_random_uuid(), ${hashSessionToken(token)}, ${hashSessionToken(generateSessionToken())},
        ${future}, ${future}, ${future}, now(), ${tenantId ?? null})`);
    return `${COOKIE_NAMES.access}=${token}`;
  }

  const get = (path: string, withCookie: string | undefined = cookie) =>
    app.inject({
      method: 'GET',
      url: `/portal/documents/${path}`,
      headers: withCookie ? { cookie: withCookie } : {},
    });

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
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const [acme, globex] = await handle.db
      .insert(tenants)
      .values([{ name: 'Acme SA' }, { name: 'Globex SA' }])
      .returning();
    const signed = { signedXml: '<DE/>', signedAt: new Date('2026-01-01T12:00:05Z') };
    const rejection = [{ code: '1321', message: 'Receptor innominado no permitido' }];
    const rows = await seedDocuments(handle.db, acme.id, ['approved', 'rejected'], (i) =>
      i === 0 ? signed : { ...signed, sifenMessages: rejection },
    );
    [ids.approved, ids.rejected] = rows.map((r) => r.id);
    cdc = rows[0].cdc;
    [ids.foreign] = (await seedDocuments(handle.db, globex.id, ['approved'])).map((r) => r.id);
    cookie = await session('lector@example.com', acme.id);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it('returns the list item plus environment, events and no rejection reason when approved', async () => {
    const res = await get(ids.approved);

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toEqual({
      id: ids.approved,
      cdc: cdc,
      type: 'FE',
      number: '001-001-0000001',
      issuedAt: '2026-01-01T12:00:00.000Z',
      receiverName: 'Private Person',
      receiverRuc: null,
      total: '110000',
      currency: 'PYG',
      status: 'approved',
      hasObservations: false,
      environment: 'test',
      events: [
        { status: 'accepted', at: expect.any(String) as string, code: null, message: null },
        { status: 'signed', at: '2026-01-01T12:00:05.000Z', code: null, message: null },
        { status: 'approved', at: expect.any(String) as string, code: null, message: null },
      ],
      rejectionReason: null,
    });
  });

  it('explains a rejection in the SIFEN words', async () => {
    const body = (await get(ids.rejected)).json<{
      rejectionReason: string;
      events: { status: string; code: string | null }[];
    }>();

    expect(body.rejectionReason).toBe('Receptor innominado no permitido');
    expect(body.events.at(-1)).toMatchObject({ status: 'rejected', code: '1321' });
  });

  it('answers 404 for another tenant, an unknown and a malformed id, ', async () => {
    for (const id of [ids.foreign, crypto.randomUUID(), 'not-a-uuid']) {
      expect((await get(id)).statusCode, id).toBe(404);
    }
  });
});
