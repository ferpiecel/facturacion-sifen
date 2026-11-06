import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { receivedArtifacts, receivedDocuments, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const CDC = '01800695631001001000000612021112917595714694';
const CDC_2 = '01800695631001001000000712021112917595714695';
const SHA_A = 'a'.repeat(64);

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

type Insert = typeof receivedDocuments.$inferInsert;

/** Spec: reception R1.3. Documents issued by third parties in favor of a tenant (purchases). */
describe('received_documents', () => {
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

  const doc = (tenantId: string, overrides: Partial<Insert> = {}): Insert => ({
    tenantId,
    source: 'sifen_xml',
    ...overrides,
  });

  async function expectRefused(
    db: DatabaseHandle['db'],
    tenantId: string,
    constraint: string,
    overrides: Partial<Insert>,
  ) {
    expect(await causeOf(db.insert(receivedDocuments).values(doc(tenantId, overrides)))).toContain(
      constraint,
    );
  }

  it('stores a document with safe defaults', async () => {
    const { db, a } = await seed();
    const [row] = await db.insert(receivedDocuments).values(doc(a)).returning();
    expect(row).toMatchObject({
      tenantId: a,
      source: 'sifen_xml',
      status: 'received',
      version: 1,
      needsReview: false,
      needsReviewReasons: [],
      isOwnReceiver: true,
      currency: 'PYG',
      sifenStatus: 'unknown',
      extractionAttempts: 0,
      cdc: null,
      artifactId: null,
      confirmedAt: null,
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('keeps money exact as numeric(23,8)', async () => {
    const { db, a } = await seed();
    const [row] = await db
      .insert(receivedDocuments)
      .values(doc(a, { totalAmount: '123456789012345.12345678', vat10: '0.00000001' }))
      .returning();
    expect(row.totalAmount).toBe('123456789012345.12345678');
    expect(row.vat10).toBe('0.00000001');
  });

  it('enforces the value domains of the enumerated columns', async () => {
    const { db, a } = await seed();
    const bad: [string, Partial<Insert>][] = [
      ['received_documents_source_valid', { source: 'manual' }],
      ['received_documents_status_valid', { status: 'emitida' }],
      ['received_documents_version_positive', { version: 0 }],
      ['received_documents_document_type_valid', { documentType: 2 }],
      ['received_documents_payment_condition_valid', { paymentCondition: 'barter' }],
      ['received_documents_sifen_status_valid', { sifenStatus: 'pending' }],
      ['received_documents_confidence_range', { confidenceOverall: '1.001' }],
      ['received_documents_confidence_range', { confidenceOverall: '-0.001' }],
      ['received_documents_error_code_format', { extractionErrorCode: 'LLM failed: bad json' }],
    ];
    for (const [constraint, override] of bad) {
      await expectRefused(db, a, constraint, override);
    }
    for (const documentType of [1, 4, 5, 6, 7]) {
      await db.insert(receivedDocuments).values(doc(a, { documentType }));
    }
    await db
      .insert(receivedDocuments)
      .values(doc(a, { confidenceOverall: '1.000', paymentCondition: 'credit' }));
  });

  it('requires a CDC to be exactly 44 digits', async () => {
    const { db, a } = await seed();
    // char(44) pads short values with spaces, so the format CHECK catches them.
    for (const cdc of [CDC.slice(1), `${CDC.slice(0, 43)}x`]) {
      await expectRefused(db, a, 'received_documents_cdc_format', { cdc });
    }
    await expectRefused(db, a, 'value too long for type character(44)', { cdc: `${CDC}0` });
    const [row] = await db
      .insert(receivedDocuments)
      .values(doc(a, { cdc: CDC }))
      .returning();
    expect(row.cdc).toBe(CDC);
  });

  it('keeps needs_review in parity with the status and reasons only while in review', async () => {
    const { db, a } = await seed();
    await expectRefused(db, a, 'received_documents_needs_review_parity', {
      status: 'needs_review',
    });
    await expectRefused(db, a, 'received_documents_needs_review_parity', { needsReview: true });
    await expectRefused(db, a, 'received_documents_reasons_only_in_review', {
      needsReviewReasons: ['low_confidence'],
    });
    const [row] = await db
      .insert(receivedDocuments)
      .values(
        doc(a, {
          status: 'needs_review',
          needsReview: true,
          needsReviewReasons: ['low_confidence', 'totals_mismatch'],
        }),
      )
      .returning();
    expect(row.needsReviewReasons).toEqual(['low_confidence', 'totals_mismatch']);
  });

  it('refuses the same CDC twice for one tenant, allows it for another and repeated NULLs', async () => {
    const { db, a, b } = await seed();
    await db.insert(receivedDocuments).values(doc(a, { cdc: CDC }));
    await expectRefused(db, a, 'received_documents_tenant_cdc_idx', { cdc: CDC });
    await db.insert(receivedDocuments).values(doc(b, { cdc: CDC }));
    await db.insert(receivedDocuments).values([doc(a), doc(a), doc(a, { cdc: CDC_2 })]);
  });

  it('dedupes paper documents by issuer, timbrado and number when all three are known', async () => {
    const { db, a, b } = await seed();
    const paper = { issuerRucBase: '80069563', timbrado: '12345678', documentNumber: '0000061' };
    await db.insert(receivedDocuments).values(doc(a, { source: 'pdf', ...paper }));
    await expectRefused(db, a, 'received_documents_tenant_number_idx', {
      source: 'photo',
      ...paper,
    });
    await db.insert(receivedDocuments).values(doc(b, { source: 'pdf', ...paper }));
    await db
      .insert(receivedDocuments)
      .values([
        doc(a, { source: 'pdf', issuerRucBase: '80069563', timbrado: '12345678' }),
        doc(a, { source: 'pdf', issuerRucBase: '80069563', timbrado: '12345678' }),
        doc(a, { source: 'pdf', ...paper, documentNumber: '0000062' }),
      ]);
  });

  it('keeps the idempotency key and request hash as a pair, unique per tenant', async () => {
    const { db, a, b } = await seed();
    const hash = 'c'.repeat(64);
    await expectRefused(db, a, 'received_documents_idempotency_pair', { idempotencyKey: 'k1' });
    await expectRefused(db, a, 'received_documents_idempotency_pair', { requestHash: hash });
    await expectRefused(db, a, 'received_documents_idempotency_key_format', {
      idempotencyKey: 'has space',
      requestHash: hash,
    });
    await expectRefused(db, a, 'received_documents_idempotency_hash_format', {
      idempotencyKey: 'k1',
      requestHash: 'C'.repeat(64),
    });
    await db.insert(receivedDocuments).values(doc(a, { idempotencyKey: 'k1', requestHash: hash }));
    await expectRefused(db, a, 'received_documents_tenant_idempotency_key_key', {
      idempotencyKey: 'k1',
      requestHash: hash,
    });
    await db.insert(receivedDocuments).values(doc(b, { idempotencyKey: 'k1', requestHash: hash }));
  });

  it('exposes (tenant_id, id) as a unique key for composite tenant foreign keys', async () => {
    const { db } = await seed();
    const rows = await queryRows<{ definition: string }>(
      db,
      sql`select pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'received_documents'::regclass and conname = 'received_documents_tenant_id_key'`,
    );
    expect(rows.map((row) => row.definition)).toEqual(['UNIQUE (tenant_id, id)']);
  });

  it('references an artifact only of the same tenant (composite foreign key)', async () => {
    const { db, a, b } = await seed();
    const [artifact] = await db
      .insert(receivedArtifacts)
      .values({ tenantId: b, storageKey: 'pdf/b', sha256: SHA_A, sizeBytes: 1 })
      .returning();
    expect(
      await causeOf(db.insert(receivedDocuments).values(doc(a, { artifactId: artifact.id }))),
    ).toContain('received_documents_artifact_fk');
    const [row] = await db
      .insert(receivedDocuments)
      .values(doc(b, { artifactId: artifact.id }))
      .returning();
    expect(row.artifactId).toBe(artifact.id);
  });

  it('refuses a document whose tenant does not exist', async () => {
    const { db } = await seed();
    await expectRefused(
      db,
      '00000000-0000-4000-8000-000000000001',
      'received_documents_tenant_id_tenants_id_fk',
      {},
    );
  });

  describe('write guard', () => {
    async function seedRow() {
      const { db, a, b } = await seed();
      const [artifact] = await db
        .insert(receivedArtifacts)
        .values({ tenantId: a, storageKey: 'pdf/a', sha256: SHA_A, sizeBytes: 1 })
        .returning();
      const [row] = await db
        .insert(receivedDocuments)
        .values(doc(a, { idempotencyKey: 'k', requestHash: 'd'.repeat(64) }))
        .returning();
      return { db, a, b, artifact, row };
    }

    it('lets the pipeline move the mutable state forward', async () => {
      const { db, row } = await seedRow();
      await db
        .update(receivedDocuments)
        .set({ status: 'extracting', version: 2, extractionAttempts: 1, totalAmount: '10' })
        .where(eq(receivedDocuments.id, row.id));
      await db
        .update(receivedDocuments)
        .set({ status: 'confirmed', confirmedAt: new Date(), confirmedBy: 'key-1' })
        .where(eq(receivedDocuments.id, row.id));
    });

    it('freezes the identity columns after insert', async () => {
      const { db, a, b, artifact, row } = await seedRow();
      const changes: Partial<Insert>[] = [
        { id: '00000000-0000-4000-8000-000000000002' },
        { tenantId: b },
        { source: 'pdf' },
        { createdAt: new Date(0) },
        { idempotencyKey: 'other' },
        { requestHash: 'e'.repeat(64) },
      ];
      for (const change of changes) {
        expect(
          await causeOf(
            db.update(receivedDocuments).set(change).where(eq(receivedDocuments.id, row.id)),
          ),
        ).toContain('received_documents: identity columns are immutable');
      }
      expect(a).toBe(row.tenantId);
      expect(artifact.id).toBeTruthy();
    });

    it('sets the CDC and the artifact once, never changes them afterwards', async () => {
      const { db, artifact, row } = await seedRow();
      const target = eq(receivedDocuments.id, row.id);
      await db.update(receivedDocuments).set({ cdc: CDC, artifactId: artifact.id }).where(target);
      for (const change of [{ cdc: CDC_2 }, { cdc: null }, { artifactId: null }]) {
        expect(await causeOf(db.update(receivedDocuments).set(change).where(target))).toContain(
          'received_documents: cdc and artifact_id are write-once',
        );
      }
    });

    it('never lets the version decrease', async () => {
      const { db, row } = await seedRow();
      const target = eq(receivedDocuments.id, row.id);
      await db.update(receivedDocuments).set({ version: 3 }).where(target);
      expect(
        await causeOf(db.update(receivedDocuments).set({ version: 2 }).where(target)),
      ).toContain('received_documents: version cannot decrease');
    });

    it('holds inside the tenant transaction as app_user', async () => {
      const { db, a, row } = await seedRow();
      expect(
        await causeOf(
          withTenantTransaction(db, a, (tx) =>
            tx
              .update(receivedDocuments)
              .set({ source: 'photo' })
              .where(eq(receivedDocuments.id, row.id)),
          ),
        ),
      ).toContain('identity columns are immutable');
    });
  });

  it('isolates by tenant: reads, cross-tenant inserts and cross-tenant updates are blocked', async () => {
    const { db, a, b } = await seed();
    await db.insert(receivedDocuments).values([doc(a), doc(b)]);

    const seenByA = await withTenantTransaction(db, a, (tx) => tx.select().from(receivedDocuments));
    expect(seenByA.map((row) => row.tenantId)).toEqual([a]);

    expect(
      await causeOf(
        withTenantTransaction(db, b, (tx) => tx.insert(receivedDocuments).values(doc(a))),
      ),
    ).toContain('row-level security');

    await withTenantTransaction(db, b, (tx) =>
      tx.update(receivedDocuments).set({ status: 'extracting' }),
    );
    const rows = await db.select().from(receivedDocuments);
    expect(rows.find((row) => row.tenantId === a)?.status).toBe('received');
    expect(rows.find((row) => row.tenantId === b)?.status).toBe('extracting');
  });

  it('gives app_user no way to delete, and partner_viewer no access at all', async () => {
    const { db, a } = await seed();
    await db.insert(receivedDocuments).values(doc(a));
    expect(
      await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(receivedDocuments))),
    ).toContain('permission denied for table received_documents');
    const grants = await queryRows<{ grantee: string }>(
      db,
      sql`select distinct grantee from information_schema.role_table_grants
          where table_name = 'received_documents' and grantee = 'partner_viewer'`,
    );
    expect(grants).toEqual([]);
  });

  it('rolls back cleanly: RLS first (0049), then the table (0048)', async () => {
    const { db } = await seed();
    // The items and confidences tables (0050/0051) reference this one, so they go first.
    for (const file of [
      '0051_received_document_items_and_confidences_rls.down.sql',
      '0050_received_document_items_and_confidences.down.sql',
      '0049_received_documents_rls.down.sql',
      '0048_received_documents.down.sql',
    ]) {
      for (const statement of rollbackStatements(file)) {
        await db.execute(sql.raw(statement));
      }
    }
    const left = await queryRows<{ relname: string }>(
      db,
      sql`select relname from pg_class where relname like 'received_documents%'`,
    );
    expect(left).toEqual([]);
    const functions = await queryRows<{ proname: string }>(
      db,
      sql`select proname from pg_proc where proname like 'received_documents%'`,
    );
    expect(functions).toEqual([]);
  });
});
