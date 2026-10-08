import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import {
  documents,
  partnerMemberships,
  partners,
  tenantCertificates,
  tenants,
  users,
} from '../src/schema.js';
import { withAppRoleTransaction } from '../src/app-role-transaction.js';
import { withPartnerTransaction } from '../src/partner-transaction.js';
import { connectAsRuntime, createTestDatabase, queryRows } from './support/harness.js';

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  return expect.unreachable('expected the query to reject');
}

const CDC = (n: number) =>
  `0180069563100100100000${String(n).padStart(2, '0')}12026010111234567891`;

/** Spec: HU-E1-06 / ADR-0014. A partner sees operational state of ITS tenants, never documents or foreign tenants. */
describe('partner status RLS', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const { db } = handle;
    const [p1, p2] = await db
      .insert(partners)
      .values([{ name: 'Partner 1' }, { name: 'Partner 2' }])
      .returning();
    const [own1, own2, foreign, direct] = await db
      .insert(tenants)
      .values([
        { name: 'Own 1', partnerId: p1.id },
        { name: 'Own 2', partnerId: p1.id, environment: 'production' },
        { name: 'Foreign', partnerId: p2.id },
        { name: 'Direct' },
      ])
      .returning();

    let n = 0;
    async function documentsFor(tenantId: string, statuses: string[]) {
      const [est] = await queryRows<{ id: string }>(
        db,
        sql`insert into tenant_establishments (tenant_id, code, address, house_number, department_code, district_code, district_description, city_code, city_description)
          values (${tenantId}, '001', 'Av. Mariscal Lopez 123', '123', '11', '145', 'Asuncion', '3432', 'Asuncion') returning id`,
      );
      const [point] = await queryRows<{ id: string }>(
        db,
        sql`insert into tenant_expedition_points (tenant_id, establishment_id, code) values (${tenantId}, ${est.id}, '001') returning id`,
      );
      const [timbrado] = await queryRows<{ id: string }>(
        db,
        sql`insert into tenant_timbrados (tenant_id, number, valid_from) values (${tenantId}, '12345678', '2024-01-01') returning id`,
      );
      for (const status of statuses) {
        n += 1;
        await db.insert(documents).values({
          tenantId,
          environment: 'test',
          timbradoId: timbrado.id,
          establishmentId: est.id,
          expeditionPointId: point.id,
          documentType: 1,
          number: n,
          cdc: CDC(n),
          securityCode: '123456789',
          issuedAt: new Date('2026-01-01T12:00:00Z'),
          totalAmount: '110000',
          receiverRuc: '80000001-1',
          payload: { items: [] },
          status,
        });
      }
    }
    await documentsFor(own1.id, ['accepted', 'accepted', 'queued']);
    await documentsFor(foreign.id, ['accepted']);

    for (const tenantId of [own1.id, foreign.id]) {
      await db.insert(tenantCertificates).values({
        tenantId,
        environment: 'test',
        sealed: { ciphertext: 'secret-material' },
        fingerprint: 'a'.repeat(64),
        subjectRuc: '80069563-1',
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2027-06-30T00:00:00Z'),
      });
    }

    const [member] = await db
      .insert(users)
      .values({
        email: 'partner@example.com',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA',
        displayName: 'Partner Admin',
      })
      .returning();
    await db.insert(partnerMemberships).values({ partnerId: p1.id, userId: member.id });

    return {
      handle,
      db,
      partner1: p1.id,
      partner2: p2.id,
      own1: own1.id,
      own2: own2.id,
      foreign: foreign.id,
      direct: direct.id,
      member: member.id,
    };
  }

  it('lists only the tenants of the partner, with operational columns', async () => {
    const s = await seed();

    const rows = await withPartnerTransaction(s.db, s.partner1, (tx) =>
      queryRows<{ id: string; name: string; environment: string }>(
        tx,
        sql`select id, name, environment from tenants order by name`,
      ),
    );

    expect(rows.map((r) => r.name)).toEqual(['Own 1', 'Own 2']);
    expect(rows.map((r) => r.id)).not.toContain(s.foreign);
    expect(rows.map((r) => r.id)).not.toContain(s.direct);

    const unset = await s.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE partner_viewer`);
      return queryRows(tx, sql`select id from tenants`);
    });
    expect(unset).toEqual([]);
  });

  it('counts document statuses only for its own tenants (partner vs foreign tenant)', async () => {
    const s = await seed();

    const rows = await withPartnerTransaction(s.db, s.partner1, (tx) =>
      queryRows<{ tenant_id: string; status: string; total: number }>(
        tx,
        sql`select tenant_id, status, count(*)::int as total from documents group by tenant_id, status order by status`,
      ),
    );

    expect(rows).toEqual([
      { tenant_id: s.own1, status: 'accepted', total: 2 },
      { tenant_id: s.own1, status: 'queued', total: 1 },
    ]);
  });

  it('reads certificate status and expiry of its tenants only', async () => {
    const s = await seed();

    const rows = await withPartnerTransaction(s.db, s.partner1, (tx) =>
      queryRows<{ tenant_id: string; status: string; not_after: Date }>(
        tx,
        sql`select tenant_id, status, not_after from tenant_certificates`,
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(s.own1);
  });

  it('cannot read document content or certificate secrets, write, or touch unrelated tables', async () => {
    const s = await seed();
    const denied = [
      ...['cdc', 'total_amount', 'receiver_ruc', 'payload', 'signed_xml'].map(
        (c) => `select ${c} from documents`,
      ),
      ...['sealed', 'fingerprint'].map((c) => `select ${c} from tenant_certificates`),
      `update tenants set name = 'x'`,
      `delete from documents`,
      `insert into tenants (name) values ('x')`,
      `select * from api_keys`,
      `select * from users`,
      `select * from partner_memberships`,
    ];

    for (const statement of denied) {
      const message = await causeOf(
        withPartnerTransaction(s.db, s.partner1, (tx) => tx.execute(sql.raw(statement))),
      );
      expect(message, statement).toMatch(/permission denied/i);
    }
    const asTenant = withAppRoleTransaction(s.db, (tx) =>
      tx.execute(sql`select * from partner_memberships`),
    );
    expect(await causeOf(asTenant)).toMatch(/permission denied/i);
  });

  it('user_in_partner is true only for a member of that partner', async () => {
    const s = await seed();

    const check = (user: string, partner: string) =>
      withAppRoleTransaction(s.db, async (tx) => {
        const [row] = await queryRows<{ ok: boolean }>(
          tx,
          sql`select user_in_partner(${user}, ${partner}) as ok`,
        );
        return row.ok;
      });

    expect(await check(s.member, s.partner1)).toBe(true);
    expect(await check(s.member, s.partner2)).toBe(false);
    expect(await check('00000000-0000-4000-8000-000000000000', s.partner1)).toBe(false);
  });

  it.runIf(process.env.DB_TEST_DRIVER === 'postgres')(
    'the real runtime login (app_login) can enter the partner role and sees only its tenants',
    async () => {
      const s = await seed();
      const runtime = connectAsRuntime(s.handle);
      try {
        const rows = await withPartnerTransaction(runtime.db, s.partner1, (tx) =>
          queryRows<{ name: string }>(tx, sql`select name from tenants order by name`),
        );
        expect(rows.map((r) => r.name)).toEqual(['Own 1', 'Own 2']);
      } finally {
        await runtime.close();
      }
    },
  );
});
