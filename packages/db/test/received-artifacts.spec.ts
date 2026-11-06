import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { receivedArtifacts, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

function rollbackStatements(file: string): string[] {
  const path = fileURLToPath(new URL(`../migrations/rollback/${file}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Spec: reception R1.2. Stored upload metadata; the bytes live in object storage, never here. */
describe('received_artifacts', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const rows = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    const [a, b] = rows.map((row) => row.id);
    return { db: handle.db, a, b };
  }

  const artifact = (
    tenantId: string,
    overrides: Partial<typeof receivedArtifacts.$inferInsert> = {},
  ): typeof receivedArtifacts.$inferInsert => ({
    tenantId,
    storageKey: `pdf/${tenantId}/${SHA_A}.pdf`,
    contentType: 'application/pdf',
    sha256: SHA_A,
    sizeBytes: 1024,
    ...overrides,
  });

  it('stores an artifact with defaults for the optional metadata', async () => {
    const { db, a } = await seed();
    const [row] = await db.insert(receivedArtifacts).values(artifact(a)).returning();
    expect(row).toMatchObject({
      tenantId: a,
      sha256: SHA_A,
      sizeBytes: 1024,
      originalName: null,
      pageCount: null,
    });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it('accepts an empty file and a size above 2^31', async () => {
    const { db, a } = await seed();
    await db.insert(receivedArtifacts).values(artifact(a, { sizeBytes: 0 }));
    const [big] = await db
      .insert(receivedArtifacts)
      .values(artifact(a, { sha256: SHA_B, storageKey: 'pdf/big', sizeBytes: 5_000_000_000 }))
      .returning();
    expect(big.sizeBytes).toBe(5_000_000_000);
  });

  it('refuses the same content twice for one tenant but allows it for another', async () => {
    const { db, a, b } = await seed();
    await db.insert(receivedArtifacts).values(artifact(a));
    expect(
      await causeOf(
        db.insert(receivedArtifacts).values(artifact(a, { storageKey: 'pdf/other-key' })),
      ),
    ).toContain('received_artifacts_tenant_sha256_key');
    await db.insert(receivedArtifacts).values(artifact(b));
  });

  it('refuses a storage key that is already used, even by another tenant', async () => {
    const { db, a, b } = await seed();
    await db.insert(receivedArtifacts).values(artifact(a, { storageKey: 'shared-key' }));
    expect(
      await causeOf(
        db
          .insert(receivedArtifacts)
          .values(artifact(b, { storageKey: 'shared-key', sha256: SHA_B })),
      ),
    ).toContain('received_artifacts_storage_key_key');
  });

  it('exposes (tenant_id, id) as a unique key for composite tenant foreign keys', async () => {
    const { db } = await seed();
    const rows = await queryRows<{ definition: string }>(
      db,
      sql`select pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'received_artifacts'::regclass and conname = 'received_artifacts_tenant_id_key'`,
    );
    expect(rows.map((row) => row.definition)).toEqual(['UNIQUE (tenant_id, id)']);
  });

  it('enforces the sha256 and size invariants', async () => {
    const { db, a } = await seed();
    const bad: [string, Partial<typeof receivedArtifacts.$inferInsert>][] = [
      ['received_artifacts_sha256_hex', { sha256: 'A'.repeat(64) }],
      ['received_artifacts_sha256_hex', { sha256: 'g'.repeat(64) }],
      ['received_artifacts_sha256_hex', { sha256: 'a'.repeat(63) }],
      ['received_artifacts_size_nonneg', { sizeBytes: -1 }],
      ['received_artifacts_page_count_positive', { pageCount: 0 }],
    ];
    for (const [i, [constraint, override]] of bad.entries()) {
      expect(
        await causeOf(
          db
            .insert(receivedArtifacts)
            .values(artifact(a, { storageKey: `key-${String(i)}`, ...override })),
        ),
      ).toContain(constraint);
    }
    await db
      .insert(receivedArtifacts)
      .values(artifact(a, { storageKey: 'with-pages', pageCount: 3, originalName: 'a.pdf' }));
  });

  it('refuses an artifact whose tenant does not exist', async () => {
    const { db } = await seed();
    expect(
      await causeOf(
        db.insert(receivedArtifacts).values(artifact('00000000-0000-4000-8000-000000000001')),
      ),
    ).toContain('received_artifacts_tenant_id_tenants_id_fk');
  });

  it('isolates by tenant: reads, cross-tenant inserts and cross-tenant updates are blocked', async () => {
    const { db, a, b } = await seed();
    await db
      .insert(receivedArtifacts)
      .values([
        artifact(a, { storageKey: 'a-key' }),
        artifact(b, { storageKey: 'b-key', sha256: SHA_B }),
      ]);

    const seenByA = await withTenantTransaction(db, a, (tx) => tx.select().from(receivedArtifacts));
    expect(seenByA.map((row) => row.tenantId)).toEqual([a]);

    expect(
      await causeOf(
        withTenantTransaction(db, b, (tx) =>
          tx.insert(receivedArtifacts).values(artifact(a, { storageKey: 'forged' })),
        ),
      ),
    ).toContain('row-level security');

    await withTenantTransaction(db, b, (tx) => tx.update(receivedArtifacts).set({ pageCount: 9 }));
    const rows = await db.select().from(receivedArtifacts);
    expect(rows.find((row) => row.tenantId === a)?.pageCount).toBeNull();
  });

  it('gives app_user no way to delete, and partner_viewer no access at all', async () => {
    const { db, a } = await seed();
    await db.insert(receivedArtifacts).values(artifact(a));
    expect(
      await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(receivedArtifacts))),
    ).toContain('permission denied for table received_artifacts');
    const grants = await queryRows<{ grantee: string }>(
      db,
      sql`select distinct grantee from information_schema.role_table_grants
          where table_name = 'received_artifacts' and grantee = 'partner_viewer'`,
    );
    expect(grants).toEqual([]);
  });

  it('rolls back cleanly: RLS first (0047), then the table (0046)', async () => {
    const { db } = await seed();
    for (const file of [
      '0047_received_artifacts_rls.down.sql',
      '0046_received_artifacts.down.sql',
    ]) {
      for (const statement of rollbackStatements(file)) {
        await db.execute(sql.raw(statement));
      }
    }
    const left = await queryRows<{ relname: string }>(
      db,
      sql`select relname from pg_class where relname like 'received_artifacts%'`,
    );
    expect(left).toEqual([]);
  });
});
