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
import { CustodyModule } from '../../custody/custody.module.js';
import { DATABASE, DatabaseModule } from '../../database/database.module.js';
import { generateSessionToken, hashSessionToken } from '../../identity/domain/session-token.js';
import { COOKIE_NAMES } from '../../identity/infrastructure/http/auth-cookies.js';
import { seedDocuments } from '../../../../test/support/document-seed.js';
import { PortalDocumentsModule } from '../portal-documents.module.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA';

interface ListBody {
  items: { id: string; number: string; status: string; type: string; hasObservations: boolean }[];
  page: number;
  pageSize: number;
  total: number;
}

describe('GET /portal/documents (HU-E12-01)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let acme: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  async function session(email: string, tenantId: string | null, role?: string) {
    const [user] = await handle.db
      .insert(users)
      .values({ email, passwordHash: HASH, displayName: email })
      .returning();
    if (tenantId && role) {
      await handle.db
        .insert(tenantMemberships)
        .values({ tenantId, userId: user.id, role: role as 'owner' });
    }
    const token = generateSessionToken();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await handle.db.execute(sql`insert into user_sessions
      (user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, absolute_expires_at, mfa_verified_at, active_tenant_id)
      values (${user.id}, gen_random_uuid(), ${hashSessionToken(token)}, ${hashSessionToken(generateSessionToken())},
        ${future}, ${future}, ${future}, now(), ${tenantId})`);
    return `${COOKIE_NAMES.access}=${token}`;
  }

  const get = (query: string, cookie?: string) =>
    app.inject({
      method: 'GET',
      url: `/portal/documents${query}`,
      headers: cookie ? { cookie } : {},
    });
  const list = async (query: string, cookie = cookies.owner) => {
    const res = await get(query, cookie);
    expect(res.statusCode).toBe(200);
    return res.json<ListBody>();
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
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const [acmeTenant, globexTenant] = await handle.db
      .insert(tenants)
      .values([{ name: 'Acme SA' }, { name: 'Globex SA' }])
      .returning();
    acme = acmeTenant.id;
    const named = (name: string) => ({ payload: { receiver: { name } } });
    const rows = await seedDocuments(
      handle.db,
      acme,
      ['approved', 'rejected', 'approved_with_observations', 'approved'],
      (i) =>
        [
          { receiverRuc: '80000001-1', ...named('Cliente SA') },
          // 2026-01-10 22:00 in Asuncion, already 2026-01-11 in UTC.
          { issuedAt: new Date('2026-01-11T01:00:00Z'), ...named('Maria Gonzalez') },
          named('Cliente SA'),
          { documentType: 5 },
        ][i],
    );
    [ids.fe1, ids.fe2, ids.obs, ids.nce] = rows.map((r) => r.id);
    [ids.foreign] = (await seedDocuments(handle.db, globexTenant.id, ['approved'])).map(
      (r) => r.id,
    );

    cookies.owner = await session('owner@example.com', acme, 'owner');
    cookies.lector = await session('lector@example.com', acme, 'lector');
    cookies.noTenant = await session('plain@example.com', null);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it('answers 401 without a verified session', async () => {
    expect((await get('')).statusCode).toBe(401);
  });

  it('answers 403 without an active tenant', async () => {
    expect((await get('', cookies.noTenant)).statusCode).toBe(403);
  });

  it('lists the active tenant documents only, newest first, for any role', async () => {
    const body = await list('', cookies.lector);

    expect(body.total).toBe(4);
    expect(body.items.map((i) => i.id)).not.toContain(ids.foreign);
    expect(new Set(body.items.map((i) => i.id))).toEqual(
      new Set([ids.fe1, ids.fe2, ids.obs, ids.nce]),
    );
    expect(body.items[0].id).toBe(ids.fe2);
  });

  it('returns the item contract', async () => {
    const body = await list('?q=80000001-1');

    expect(body.items).toEqual([
      {
        id: ids.fe1,
        cdc: expect.stringMatching(/^\d{44}$/) as string,
        type: 'FE',
        number: '001-001-0000001',
        issuedAt: '2026-01-01T12:00:00.000Z',
        receiverName: 'Cliente SA',
        receiverRuc: '80000001-1',
        total: '110000',
        currency: 'PYG',
        status: 'approved',
        hasObservations: false,
      },
    ]);
  });

  it('filters by type, status and flags observations', async () => {
    expect((await list('?type=NCE')).items.map((i) => i.id)).toEqual([ids.nce]);
    expect((await list('?type=FE&status=rejected')).items.map((i) => i.id)).toEqual([ids.fe2]);
    const obs = await list('?status=approved_with_observations');
    expect(obs.items.map((i) => [i.id, i.hasObservations])).toEqual([[ids.obs, true]]);
  });

  it('filters by Asuncion calendar day, inclusive', async () => {
    expect((await list('?from=2026-01-10&to=2026-01-10')).items.map((i) => i.id)).toEqual([
      ids.fe2,
    ]);
    expect((await list('?from=2026-01-11')).total).toBe(0);
    expect((await list('?to=2026-01-09')).total).toBe(3);
  });

  it('searches by receiver name, number and CDC, never across tenants', async () => {
    expect((await list('?q=maria')).items.map((i) => i.id)).toEqual([ids.fe2]);
    expect((await list('?q=001-001-0000003')).items.map((i) => i.id)).toEqual([ids.obs]);
    expect((await list('?q=0180069563100100100000')).total).toBe(4);
    expect((await list('?q=100%25')).total).toBe(0);
  });

  it('paginates with a stable order and reports the total', async () => {
    const first = await list('?page=1&pageSize=3');
    const second = await list('?page=2&pageSize=3');

    expect(first).toMatchObject({ page: 1, pageSize: 3, total: 4 });
    expect(first.items).toHaveLength(3);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(4);
    expect((await list('?page=9')).items).toEqual([]);
  });

  it.each(['?type=XX', '?status=bogus', '?from=2026-02-30', '?page=0', '?pageSize=101'])(
    'answers 400 for %s',
    async (query) => {
      expect((await get(query, cookies.owner)).statusCode).toBe(400);
    },
  );
});
