import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  partnerMemberships,
  partners,
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
import { PartnersModule } from '../partners.module.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA';
const CDC = '01800695631001001000000112026010111234567891';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('GET /partners/:partnerId/tenants/status (HU-E1-06)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let partner1: string;
  let partner2: string;
  let own: string;
  let foreign: string;
  const cookies: Record<string, string> = {};

  async function signedInUser(email: string, partnerId?: string): Promise<string> {
    const [user] = await handle.db
      .insert(users)
      .values({ email, passwordHash: HASH, displayName: email })
      .returning();
    if (partnerId) {
      await handle.db.insert(partnerMemberships).values({ partnerId, userId: user.id });
    }
    const token = generateSessionToken();
    const future = new Date(Date.now() + 3_600_000);
    await handle.db.execute(sql`insert into user_sessions
      (user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, absolute_expires_at, mfa_verified_at)
      values (${user.id}, gen_random_uuid(), ${hashSessionToken(token)}, ${hashSessionToken(generateSessionToken())},
        ${future.toISOString()}, ${future.toISOString()}, ${future.toISOString()}, now())`);
    return `${COOKIE_NAMES.access}=${token}`;
  }

  const get = (partnerId: string, cookie?: string) =>
    app.inject({
      method: 'GET',
      url: `/partners/${partnerId}/tenants/status`,
      headers: cookie ? { cookie } : {},
    });

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        CustodyModule,
        PartnersModule,
      ],
    })
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const [p1, p2] = await handle.db
      .insert(partners)
      .values([{ name: 'P1' }, { name: 'P2' }])
      .returning();
    partner1 = p1.id;
    partner2 = p2.id;
    const [t1, t2] = await handle.db
      .insert(tenants)
      .values([
        { name: 'Resto Own', partnerId: partner1 },
        { name: 'Resto Foreign', partnerId: partner2 },
      ])
      .returning();
    own = t1.id;
    foreign = t2.id;
    for (const tenantId of [own, foreign]) {
      await handle.db.execute(sql`insert into tenant_certificates
        (tenant_id, environment, sealed, fingerprint, subject_ruc, not_before, not_after)
        values (${tenantId}, 'test', '{}'::jsonb, ${'a'.repeat(64)}, '80069563-1', '2026-01-01', '2027-06-30')`);
    }
    const insertId = async (query: ReturnType<typeof sql>): Promise<string> =>
      ((await handle.db.execute(query)) as { rows: { id: string }[] }).rows[0].id;
    const ids = async (tenantId: string) => {
      const est = await insertId(sql`insert into tenant_establishments
        (tenant_id, code, address, house_number, department_code, district_code, district_description, city_code, city_description)
        values (${tenantId}, '001', 'Av. Mariscal Lopez 123', '123', '11', '145', 'Asuncion', '3432', 'Asuncion') returning id`);
      const point =
        await insertId(sql`insert into tenant_expedition_points (tenant_id, establishment_id, code)
        values (${tenantId}, ${est}, '001') returning id`);
      const timbrado =
        await insertId(sql`insert into tenant_timbrados (tenant_id, number, valid_from)
        values (${tenantId}, '12345678', '2024-01-01') returning id`);
      return { est, point, timbrado };
    };
    let n = 0;
    for (const [tenantId, statuses] of [
      [own, ['accepted', 'accepted', 'queued']],
      [foreign, ['accepted']],
    ] as const) {
      const fk = await ids(tenantId);
      for (const status of statuses) {
        n += 1;
        await handle.db.execute(sql`insert into documents
          (tenant_id, environment, timbrado_id, establishment_id, expedition_point_id, document_type, number, cdc,
           security_code, issued_at, total_amount, receiver_ruc, payload, status)
          values (${tenantId}, 'test', ${fk.timbrado}, ${fk.est}, ${fk.point}, 1, ${n}, ${n === 1 ? CDC : `0180069563100100100000${String(n).padStart(2, '0')}12026010111234567891`},
           '123456789', now(), 110000, '80000001-1', '{"items":[]}'::jsonb, ${status})`);
      }
    }
    cookies.member = await signedInUser('member@example.com', partner1);
    cookies.otherPartner = await signedInUser('other@example.com', partner2);
    cookies.noPartner = await signedInUser('plain@example.com');
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it('lists only the partner tenants with certificate and counts, and no document content', async () => {
    const res = await get(partner1, cookies.member);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      partnerId: partner1,
      tenants: [
        {
          tenantId: own,
          name: 'Resto Own',
          environment: 'test',
          certificate: { status: 'active', expiresAt: '2027-06-30T00:00:00.000Z' },
          documentsByStatus: { accepted: 2, queued: 1 },
        },
      ],
    });
    for (const secret of [CDC, '80000001', '110000', 'payload', foreign]) {
      expect(res.payload).not.toContain(secret);
    }
  });

  it('answers 404 for a partner the user does not belong to, an unknown one, or a malformed id', async () => {
    expect((await get(partner2, cookies.member)).statusCode).toBe(404);
    expect((await get(partner1, cookies.otherPartner)).statusCode).toBe(404);
    expect((await get(partner1, cookies.noPartner)).statusCode).toBe(404);
    expect((await get(UNKNOWN, cookies.member)).statusCode).toBe(404);
    expect((await get('not-a-uuid', cookies.member)).statusCode).toBe(404);
  });

  it('answers 401 without a verified session', async () => {
    expect((await get(partner1)).statusCode).toBe(401);
    expect((await get(partner1, `${COOKIE_NAMES.access}=forged`)).statusCode).toBe(401);
  });
});
