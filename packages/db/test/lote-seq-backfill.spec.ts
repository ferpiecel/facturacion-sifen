import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { createTestDatabaseMigratedTo } from './support/partial-migrations.js';
import { queryRows } from './support/harness.js';

const CDC_RESENT = '01800695631001001000000112026010111234567891';
const CDC_PLAIN = '01800695631001001000000212026010111234567892';

/** Spec: hardening E6. Migration 0070 backfills `lotes.seq` and `documents.resent_after_seq` on a populated database. */
describe('0070_lote_seq backfill', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('numbers existing lotes by (created_at, id) and the resent watermark by the lotes left behind', async () => {
    handle = await createTestDatabaseMigratedTo('0069_documents_corrections');
    const { db } = handle;
    const run = async (query: ReturnType<typeof sql>) =>
      queryRows<Record<string, unknown>>(db, query);

    const [tenant] = await run(sql`insert into tenants (name) values ('A') returning id`);
    const t = tenant.id as string;
    const [est] = await run(sql`
      insert into tenant_establishments (tenant_id, code, address, house_number, department_code, district_code,
        district_description, city_code, city_description)
      values (${t}, '001', 'Av. Mariscal Lopez 123', '123', '11', '145', 'Asuncion', '3432', 'Asuncion') returning id`);
    const [point] = await run(
      sql`insert into tenant_expedition_points (tenant_id, establishment_id, code) values (${t}, ${est.id}, '001') returning id`,
    );
    const [timbrado] = await run(
      sql`insert into tenant_timbrados (tenant_id, number, valid_from) values (${t}, '12345678', '2024-01-01') returning id`,
    );
    const addDocument = async (number: number, cdc: string) => {
      const [row] = await run(sql`
        insert into documents (tenant_id, environment, timbrado_id, establishment_id, expedition_point_id,
          document_type, number, cdc, security_code, status, issued_at, total_amount, payload)
        values (${t}, 'test', ${timbrado.id}, ${est.id}, ${point.id}, 1, ${number}, ${cdc}, '123456789',
          'submitted', now(), 110000, '{}'::jsonb) returning id`);
      return row.id as string;
    };
    // Ids are random UUIDs; created_at is what must drive the numbering, so insert the later lote first.
    const addLote = async (createdAt: string) => {
      const [row] = await run(sql`
        insert into lotes (tenant_id, environment, document_type, status, created_at)
        values (${t}, 'test', 1, 'processed', ${createdAt}::timestamptz) returning id`);
      return row.id as string;
    };
    const later = await addLote('2026-02-01T00:00:00Z');
    const earlier = await addLote('2026-01-01T00:00:00Z');
    const resent = await addDocument(1, CDC_RESENT);
    const plain = await addDocument(2, CDC_PLAIN);
    // Stamp resent_at without the 0070 trigger (it does not exist yet), between the two lotes.
    await run(
      sql`insert into lote_documents (tenant_id, lote_id, document_id) values (${t}, ${earlier}, ${resent})`,
    );
    await run(
      sql`update documents set status = 'queued', resent_at = '2026-01-15T00:00:00Z', transmission_attempts = 1 where id = ${resent}`,
    );

    await handle.migrate();

    const seqs = await run(sql`select id, seq::int as seq from lotes order by seq`);
    expect(seqs.map((row) => row.id)).toEqual([earlier, later]);
    expect(seqs.map((row) => row.seq)).toEqual([1, 2]);

    const docs = await run(
      sql`select id, resent_after_seq::int as w from documents where tenant_id = ${t}`,
    );
    expect(docs.find((row) => row.id === resent)?.w).toBe(1);
    expect(docs.find((row) => row.id === plain)?.w).toBeNull();

    const guards = await run(sql`
      select c.relname, c.relforcerowsecurity as forced,
        bool_and(tg.tgenabled = 'O') as triggers_on, count(tg.oid)::int as triggers
      from pg_class c
      left join pg_trigger tg on tg.tgrelid = c.oid and not tg.tgisinternal
      where c.relname in ('lotes', 'documents') and c.relnamespace = 'public'::regnamespace
      group by c.relname, c.relforcerowsecurity order by c.relname`);
    expect(guards).toHaveLength(2);
    for (const row of guards) {
      expect(row.forced).toBe(true);
      expect(row.triggers).toBeGreaterThan(0);
      expect(row.triggers_on).toBe(true);
    }
  });
});
