import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import {
  documents,
  loteDocuments,
  lotes,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
} from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  return expect.unreachable('expected the query to reject');
}

const CDC_A = '01800695631001001000000112026010111234567891';
const CDC_B = '01800695631001001000000212026010111234567892';
const CDC_C = '01800695631001001000000312026010111234567893';
const CDC_D = '01800695631001001000000412026010111234567894';

/** Spec: HU-E5-01 (DB part). Accepted fiscal documents, isolated per tenant by RLS. */
describe('documents', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const { db } = handle;
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();

    async function fiscalSetup(tenantId: string) {
      const [est] = await db
        .insert(tenantEstablishments)
        .values({
          tenantId,
          code: '001',
          address: 'Av. Mariscal Lopez 123',
          houseNumber: '123',
          departmentCode: '11',
          districtCode: '145',
          districtDescription: 'Asuncion',
          cityCode: '3432',
          cityDescription: 'Asuncion',
        })
        .returning();
      const [point] = await db
        .insert(tenantExpeditionPoints)
        .values({ tenantId, establishmentId: est.id, code: '001' })
        .returning();
      const [timbrado] = await db
        .insert(tenantTimbrados)
        .values({ tenantId, number: '12345678', validFrom: '2024-01-01' })
        .returning();
      return { timbradoId: timbrado.id, establishmentId: est.id, expeditionPointId: point.id };
    }

    const setupA = await fiscalSetup(a.id);
    const setupB = await fiscalSetup(b.id);
    const doc = (
      tenantId: string,
      setup: typeof setupA,
      overrides: Partial<typeof documents.$inferInsert> = {},
    ): typeof documents.$inferInsert => ({
      tenantId,
      environment: 'test',
      ...setup,
      documentType: 1,
      number: 1,
      cdc: CDC_A,
      securityCode: '123456789',
      issuedAt: new Date('2026-01-01T12:00:00Z'),
      totalAmount: '110000',
      payload: { items: [] },
      ...overrides,
    });
    return { db, a: a.id, b: b.id, setupA, setupB, doc };
  }

  it('stores a document as accepted with an empty series by default', async () => {
    const { db, a, setupA, doc } = await seed();
    const [row] = await db.insert(documents).values(doc(a, setupA)).returning();
    expect(row.status).toBe('accepted');
    expect(row.series).toBe('');
    expect(row.currency).toBe('PYG');
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('isolates reads and writes by tenant through RLS', async () => {
    const { db, a, b, setupA, setupB, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    await db.insert(documents).values(doc(b, setupB, { cdc: CDC_B }));

    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(documents));
    expect(seen.map((r) => r.tenantId)).toEqual([a]);

    const crossTenant = withTenantTransaction(db, a, (tx) =>
      tx.insert(documents).values(doc(b, setupB, { cdc: CDC_B, number: 2 })),
    );
    expect(await causeOf(crossTenant)).toContain('row-level security');
  });

  it('lets app_user insert and update but never delete', async () => {
    const { db, a, setupA, doc } = await seed();
    await withTenantTransaction(db, a, (tx) => tx.insert(documents).values(doc(a, setupA)));
    await withTenantTransaction(db, a, (tx) =>
      tx.update(documents).set({ status: 'signed' }).where(eq(documents.cdc, CDC_A)),
    );
    expect(await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(documents)))).toContain(
      'permission denied for table documents',
    );
  });

  it('rejects a duplicate CDC and a duplicate number in the same sequence', async () => {
    const { db, a, setupA, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    expect(await causeOf(db.insert(documents).values(doc(a, setupA, { number: 2 })))).toContain(
      'documents_tenant_environment_cdc_key',
    );
    expect(await causeOf(db.insert(documents).values(doc(a, setupA, { cdc: CDC_B })))).toContain(
      'documents_sequence_number_key',
    );
  });

  it('rejects malformed identity values', async () => {
    const { db, a, setupA, doc } = await seed();
    const bad: [Partial<typeof documents.$inferInsert>, string][] = [
      [{ cdc: '123' }, 'documents_cdc_format'],
      [{ securityCode: '12345678A' }, 'documents_security_code_format'],
      [{ number: 10_000_000 }, 'documents_number_range'],
      [{ documentType: 9 }, 'documents_document_type_range'],
      [{ series: 'ÑA' }, 'documents_series_format'],
      [{ status: 'bogus' }, 'documents_status_valid'],
    ];
    for (const [overrides, constraint] of bad) {
      expect(await causeOf(db.insert(documents).values(doc(a, setupA, overrides)))).toContain(
        constraint,
      );
    }
  });

  it('makes the identity columns immutable but lets the status advance', async () => {
    const { db, a, setupA, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    expect(await causeOf(db.update(documents).set({ cdc: CDC_B }))).toContain('immutable');
    expect(await causeOf(db.update(documents).set({ number: 2 }))).toContain('immutable');
    expect(await causeOf(db.update(documents).set({ payload: { items: [1] } }))).toContain(
      'immutable',
    );
    const [row] = await db.update(documents).set({ status: 'signed' }).returning();
    expect(row.status).toBe('signed');
  });
  /** Spec: HU-E6-02. The signed XML is stored once, with its signing instant. */
  describe('signed XML', () => {
    const update = (
      db: DatabaseHandle['db'],
      tenantId: string,
      set: Partial<typeof documents.$inferInsert>,
    ) =>
      withTenantTransaction(db, tenantId, (tx) =>
        tx.update(documents).set(set).where(eq(documents.cdc, CDC_A)).returning(),
      );

    it('starts empty and accepts the XML once, together with a status move', async () => {
      const { db, a, setupA, doc } = await seed();
      const [created] = await db.insert(documents).values(doc(a, setupA)).returning();
      expect(created.signedXml).toBeNull();
      expect(created.signedAt).toBeNull();
      const signedAt = new Date('2026-01-01T12:00:05Z');
      const [row] = await update(db, a, { status: 'signed', signedXml: '<rDE/>', signedAt });
      expect(row).toMatchObject({ status: 'signed', signedXml: '<rDE/>', signedAt });
    });

    it('makes signed_xml and signed_at write-once', async () => {
      const { db, a, setupA, doc } = await seed();
      const signedAt = new Date('2026-01-01T12:00:05Z');
      await db
        .insert(documents)
        .values(doc(a, setupA, { status: 'signed', signedXml: '<rDE/>', signedAt }));
      expect(await causeOf(update(db, a, { signedXml: '<rDE>2</rDE>' }))).toContain('write-once');
      expect(await causeOf(update(db, a, { signedXml: null }))).toContain('write-once');
      expect(await causeOf(update(db, a, { signedAt: new Date('2026-02-01') }))).toContain(
        'write-once',
      );
    });

    it('sets the XML only while the document becomes or is signed', async () => {
      const signedAt = new Date('2026-01-01T12:00:05Z');
      for (const [from, to] of [
        ['accepted', 'accepted'],
        ['accepted', 'queued'],
        ['queued', 'queued'],
        ['queued', 'submitted'],
        ['submitted', 'submitted'],
      ]) {
        const { db, a, setupA, doc } = await seed();
        await db.insert(documents).values(doc(a, setupA, { status: from }));
        expect(
          await causeOf(update(db, a, { status: to, signedXml: '<rDE/>', signedAt })),
        ).toContain('while signing');
      }
    });

    it('lets a signed document without XML receive it', async () => {
      const { db, a, setupA, doc } = await seed();
      await db.insert(documents).values(doc(a, setupA, { status: 'signed' }));
      const signedAt = new Date('2026-01-01T12:00:05Z');
      const [row] = await update(db, a, { signedXml: '<rDE/>', signedAt });
      expect(row).toMatchObject({ signedXml: '<rDE/>', signedAt });
    });

    it('requires signed_xml and signed_at together', async () => {
      const { db, a, setupA, doc } = await seed();
      expect(
        await causeOf(db.insert(documents).values(doc(a, setupA, { signedXml: '<rDE/>' }))),
      ).toContain('documents_signed_pair');
      expect(
        await causeOf(
          db.insert(documents).values(doc(a, setupA, { signedAt: new Date('2026-01-01') })),
        ),
      ).toContain('documents_signed_pair');
    });

    it('keeps the status guard: no regression even with the XML present', async () => {
      const { db, a, setupA, doc } = await seed();
      await db.insert(documents).values(
        doc(a, setupA, {
          status: 'queued',
          signedXml: '<rDE/>',
          signedAt: new Date('2026-01-01T12:00:05Z'),
        }),
      );
      expect(await causeOf(update(db, a, { status: 'accepted' }))).toContain(
        'invalid status transition',
      );
    });
  });

  /** Spec: HU-E6-03. SIFEN outcomes are entered once, from `submitted`, and never regress. */
  describe('status transitions', () => {
    const move = (
      db: DatabaseHandle['db'],
      tenantId: string,
      set: Partial<typeof documents.$inferInsert>,
    ) =>
      withTenantTransaction(db, tenantId, (tx) =>
        tx.update(documents).set(set).where(eq(documents.cdc, CDC_A)).returning(),
      );

    it.each([
      ['accepted', 'signed'],
      ['accepted', 'submitted'],
      ['signed', 'queued'],
      ['queued', 'submitted'],
      ['submitted', 'approved'],
      ['submitted', 'approved_with_observations'],
      ['submitted', 'rejected'],
      ['approved', 'cancelled'],
      ['rejected', 'corrected'],
    ])('allows %s -> %s', async (from, to) => {
      const { db, a, setupA, doc } = await seed();
      await db.insert(documents).values(doc(a, setupA, { status: from }));
      const [row] = await move(db, a, { status: to });
      expect(row.status).toBe(to);
    });

    it.each([
      ['accepted', 'approved'],
      ['signed', 'rejected'],
      ['submitted', 'accepted'],
      ['approved', 'submitted'],
      ['approved', 'rejected'],
      ['rejected', 'approved'],
      ['approved_with_observations', 'approved'],
      ['cancelled', 'approved'],
      ['cancelled', 'accepted'],
    ])('rejects %s -> %s', async (from, to) => {
      const { db, a, setupA, doc } = await seed();
      await db.insert(documents).values(doc(a, setupA, { status: from }));
      expect(await causeOf(move(db, a, { status: to }))).toContain('invalid status transition');
    });

    it('stores the SIFEN messages next to the outcome', async () => {
      const { db, a, setupA, doc } = await seed();
      await db.insert(documents).values(doc(a, setupA, { status: 'submitted' }));
      const messages = [{ code: '1005', message: 'Extemporáneo' }];
      const [row] = await move(db, a, {
        status: 'approved_with_observations',
        sifenMessages: messages,
      });
      expect(row.sifenMessages).toEqual(messages);
    });
  });

  describe('audited resend after 0420 (HU-E6-04)', () => {
    /** A submitted document linked to a lote in `loteStatus` (or to none). */
    async function seedResend(
      loteStatus: string | null,
      overrides: Partial<typeof documents.$inferInsert> = {},
    ) {
      const { db, a, setupA, doc } = await seed();
      const [row] = await db
        .insert(documents)
        .values(doc(a, setupA, { status: 'submitted', ...overrides }))
        .returning();
      if (loteStatus !== null) {
        const [lote] = await db
          .insert(lotes)
          .values({ tenantId: a, environment: 'test', documentType: 1, status: loteStatus })
          .returning();
        await db.insert(loteDocuments).values({ tenantId: a, loteId: lote.id, documentId: row.id });
      }
      const requeue = (set: Partial<typeof documents.$inferInsert> = {}) =>
        withTenantTransaction(db, a, (tx) =>
          tx
            .update(documents)
            .set({
              status: 'queued',
              resentAt: new Date('2026-10-05T12:00:00Z'),
              transmissionAttempts: 1,
              ...set,
            })
            .where(eq(documents.cdc, CDC_A))
            .returning(),
        );
      return { db, a, row, requeue };
    }

    it('starts without a resend instant', async () => {
      const { row } = await seedResend(null);
      expect(row.resentAt).toBeNull();
    });

    it.each(['recovery', 'unknown', 'processed'])(
      'allows submitted -> queued, stamped and counted, when the lote is %s',
      async (loteStatus) => {
        const { requeue } = await seedResend(loteStatus);
        const [updated] = await requeue();
        expect(updated).toMatchObject({ status: 'queued', transmissionAttempts: 1 });
        expect(updated.resentAt).toEqual(new Date('2026-10-05T12:00:00Z'));
      },
    );

    it.each(['pending', 'sending', 'sent', 'rejected'])(
      'rejects submitted -> queued while the lote is still %s: SIFEN may be working on it',
      async (loteStatus) => {
        const { requeue } = await seedResend(loteStatus);
        expect(await causeOf(requeue())).toContain('invalid status transition');
      },
    );

    it('rejects submitted -> queued for a document that belongs to no lote', async () => {
      const { requeue } = await seedResend(null);
      expect(await causeOf(requeue())).toContain('invalid status transition');
    });

    it('rejects submitted -> queued without the resend stamp, or without counting the attempt', async () => {
      const { requeue } = await seedResend('recovery');
      expect(await causeOf(requeue({ resentAt: null }))).toContain('invalid status transition');
      expect(await causeOf(requeue({ transmissionAttempts: 0 }))).toContain(
        'invalid status transition',
      );
      expect(await causeOf(requeue({ transmissionAttempts: 2 }))).toContain(
        'invalid status transition',
      );
    });

    it('rejects submitted -> queued for a held document', async () => {
      const { requeue } = await seedResend('recovery', {
        transmissionHold: 'recovery:0420-unresolved',
      });
      expect(await causeOf(requeue())).toContain('invalid status transition');
    });

    it('rejects a second resend: the stamp is write-once', async () => {
      const { db, a, requeue } = await seedResend('recovery');
      await requeue();
      await withTenantTransaction(db, a, (tx) =>
        tx.update(documents).set({ status: 'submitted' }).where(eq(documents.cdc, CDC_A)),
      );
      expect(
        await causeOf(
          requeue({ resentAt: new Date('2026-10-06T12:00:00Z'), transmissionAttempts: 2 }),
        ),
      ).toContain('resent_at');
    });

    it('lets a queued document of an unanswered lote be stamped once, counted, without a status move', async () => {
      const { db, a } = await seedResend('unknown', { status: 'queued' });
      const stamp = (set: Partial<typeof documents.$inferInsert>) =>
        withTenantTransaction(db, a, (tx) =>
          tx.update(documents).set(set).where(eq(documents.cdc, CDC_A)).returning(),
        );
      const stamped = new Date('2026-10-05T12:00:00Z');
      const [row] = await stamp({ resentAt: stamped, transmissionAttempts: 1 });
      expect(row).toMatchObject({ status: 'queued', transmissionAttempts: 1 });
      expect(row.resentAt).toEqual(stamped);
      expect(await causeOf(stamp({ resentAt: null }))).toContain('resent_at');
      expect(await causeOf(stamp({ resentAt: new Date('2026-10-06T12:00:00Z') }))).toContain(
        'resent_at',
      );
    });

    it('rejects stamping a queued document without the same conditions as the door', async () => {
      const noLote = await seedResend(null, { status: 'queued' });
      expect(
        await causeOf(
          withTenantTransaction(noLote.db, noLote.a, (tx) =>
            tx
              .update(documents)
              .set({ resentAt: new Date(), transmissionAttempts: 1 })
              .where(eq(documents.cdc, CDC_A)),
          ),
        ),
      ).toContain('resent_at');
    });

    it('rejects resent_at on INSERT: only the recovery sets it, by queueing a document again', async () => {
      const { db, a, setupA, doc } = await seed();
      expect(
        await causeOf(
          db
            .insert(documents)
            .values(
              doc(a, setupA, { status: 'queued', resentAt: new Date('2026-10-05T12:00:00Z') }),
            ),
        ),
      ).toContain('resent_at');
    });

    it.each(['accepted', 'signed', 'submitted', 'approved', 'rejected'])(
      'rejects stamping resent_at on a %s document that is not being queued again',
      async (status) => {
        const { db, a } = await seedResend('processed', { status });
        expect(
          await causeOf(
            withTenantTransaction(db, a, (tx) =>
              tx
                .update(documents)
                .set({ resentAt: new Date('2026-10-05T12:00:00Z'), transmissionAttempts: 1 })
                .where(eq(documents.cdc, CDC_A)),
            ),
          ),
        ).toContain('resent_at');
      },
    );

    it.each([['approved'], ['approved_with_observations'], ['rejected'], ['cancelled']])(
      'never re-queues a %s document, stamp or not',
      async (status) => {
        const { requeue } = await seedResend('processed', { status });
        expect(await causeOf(requeue())).toMatch(/invalid status transition|resent_at/);
      },
    );
  });

  it('rejects an environment that differs from the tenant environment on insert', async () => {
    const { db, a, setupA, doc } = await seed();
    const message = await causeOf(
      db.insert(documents).values(doc(a, setupA, { environment: 'production' })),
    );
    expect(message).toContain('environment must match');
  });

  it('makes receiver_ruc, currency and created_at immutable too', async () => {
    const { db, a, setupA, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    expect(await causeOf(db.update(documents).set({ receiverRuc: '1234567-8' }))).toContain(
      'immutable',
    );
    expect(await causeOf(db.update(documents).set({ currency: 'USD' }))).toContain('immutable');
    expect(
      await causeOf(db.update(documents).set({ createdAt: new Date('2020-01-01T00:00:00Z') })),
    ).toContain('immutable');
  });

  it('enforces immutability for app_user inside a tenant transaction', async () => {
    const { db, a, setupA, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    const attempt = withTenantTransaction(db, a, (tx) =>
      tx.update(documents).set({ cdc: CDC_B }).where(eq(documents.cdc, CDC_A)),
    );
    expect(await causeOf(attempt)).toContain('immutable');
  });

  it('does not let another tenant update a document (0 rows affected)', async () => {
    const { db, a, b, setupA, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    const updated = await withTenantTransaction(db, b, (tx) =>
      tx
        .update(documents)
        .set({ status: 'signed' })
        .where(eq(documents.cdc, CDC_A))
        .returning({ id: documents.id }),
    );
    expect(updated).toEqual([]);
    const [row] = await db.select().from(documents);
    expect(row.status).toBe('accepted');
  });

  it("rejects a document that references another tenant's timbrado or expedition point", async () => {
    const { db, a, setupA, setupB, doc } = await seed();
    expect(
      await causeOf(db.insert(documents).values(doc(a, setupA, { timbradoId: setupB.timbradoId }))),
    ).toContain('documents_tenant_timbrado_fk');
    expect(
      await causeOf(
        db.insert(documents).values(
          doc(a, setupA, {
            establishmentId: setupB.establishmentId,
            expeditionPointId: setupB.expeditionPointId,
          }),
        ),
      ),
    ).toContain('documents_tenant_point_fk');
  });

  it('keeps an idempotency key unique per tenant and requires its request hash (HU-E5-02)', async () => {
    const { db, a, b, setupA, setupB, doc } = await seed();
    const hash = 'a'.repeat(64);
    await db.insert(documents).values(doc(a, setupA, { idempotencyKey: 'k1', requestHash: hash }));

    expect(
      await causeOf(
        db
          .insert(documents)
          .values(
            doc(a, setupA, { cdc: CDC_B, number: 2, idempotencyKey: 'k1', requestHash: hash }),
          ),
      ),
    ).toContain('documents_tenant_idempotency_key_key');
    // Another tenant may reuse the key; documents without a key may coexist.
    await db
      .insert(documents)
      .values(doc(b, setupB, { cdc: CDC_B, idempotencyKey: 'k1', requestHash: hash }));
    await db.insert(documents).values(doc(a, setupA, { cdc: CDC_B, number: 3 }));
    await db.insert(documents).values(doc(a, setupA, { cdc: CDC_C, number: 4 }));

    const bad: Partial<typeof documents.$inferInsert>[] = [
      { idempotencyKey: 'k2' },
      { requestHash: hash },
      { idempotencyKey: 'k2', requestHash: 'XYZ' },
      { idempotencyKey: '', requestHash: hash },
    ];
    for (const [index, overrides] of bad.entries()) {
      expect(
        await causeOf(
          db
            .insert(documents)
            .values(doc(a, setupA, { cdc: CDC_D, number: 10 + index, ...overrides })),
        ),
      ).toMatch(/documents_idempotency_/);
    }
  });

  it('makes idempotency_key and request_hash immutable once set', async () => {
    const { db, a, setupA, doc } = await seed();
    await db
      .insert(documents)
      .values(doc(a, setupA, { idempotencyKey: 'k1', requestHash: 'a'.repeat(64) }));
    expect(await causeOf(db.update(documents).set({ idempotencyKey: 'k2' }))).toContain(
      'immutable',
    );
    expect(await causeOf(db.update(documents).set({ requestHash: 'b'.repeat(64) }))).toContain(
      'immutable',
    );
  });
});
