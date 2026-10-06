import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
  createPgliteDatabase,
  auditLog,
  documents,
  loteDocuments,
  lotes,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  webhookDeliveries,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { seedWebhookEndpoint } from '../../../../test/support/document-seed.js';
import { FakeSifenGateway, sifenScenarios } from '@sifen/sifen-gateway';
import { RecoverLoteByCdc, type LoteRecoveryOutcome } from '../application/recover-lote-by-cdc.js';
import {
  createDrizzleLoteRecoveryStore,
  RECOVERY_AFTER_RESEND_HOLD,
  RECOVERY_ATTEMPTS_EXHAUSTED_HOLD,
  RECOVERY_UNRESOLVED_HOLD,
} from './drizzle-lote-recovery-store.js';

const SENT_AT = new Date('2026-10-01T12:00:00.000Z');
const HANDED_OVER_AT = new Date('2026-10-03T12:05:00.000Z');
const RECOVERED_AT = new Date('2026-10-03T12:16:00.000Z');
const CDC_A = '01800695631001001000000112026010111234567891';
const CDC_B = '01800695631001001000000212026010111234567892';

/** Spec: HU-E6-04 (S1). LoteRecoveryStore over lotes + documents, run as app_user under RLS. */
describe('DrizzleLoteRecoveryStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let loteId: string;

  beforeEach(async () => {
    warnings.length = 0;
    handle = createPgliteDatabase();
    await handle.migrate();
    const { db } = handle;
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
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
    const docs = await db
      .insert(documents)
      .values(
        [CDC_A, CDC_B].map((cdc, i) => ({
          tenantId,
          environment: 'test' as const,
          timbradoId: timbrado.id,
          establishmentId: est.id,
          expeditionPointId: point.id,
          documentType: 1,
          number: i + 1,
          cdc,
          securityCode: '123456789',
          status: 'submitted',
          issuedAt: new Date('2026-01-01T12:00:00Z'),
          totalAmount: '110000',
          payload: {},
        })),
      )
      .returning();
    const [lote] = await db
      .insert(lotes)
      .values({
        tenantId,
        environment: 'test',
        documentType: 1,
        status: 'sent',
        sifenProtocol: '4500123',
        sentAt: SENT_AT,
        nextPollAt: SENT_AT,
        pollDeadlineAt: new Date('2026-10-03T12:00:00.000Z'),
      })
      .returning();
    loteId = lote.id;
    await db
      .insert(loteDocuments)
      .values(docs.map((d) => ({ tenantId, loteId, documentId: d.id })));
    await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .update(lotes)
        .set({ status: 'recovery', nextPollAt: null, lastPolledAt: HANDED_OVER_AT })
        .where(eq(lotes.id, loteId)),
    );
  });

  afterEach(async () => {
    await handle.close();
  });

  const warnings: string[] = [];
  const storeFor = (tenant: string) =>
    createDrizzleLoteRecoveryStore({
      db: handle.db,
      tenantId: tenant,
      logger: { warn: (message) => warnings.push(message) },
    });
  const guard = {
    expectedStatus: 'recovery',
    expectedLastPolledAt: HANDED_OVER_AT as Date | null,
    recoveredAt: RECOVERED_AT,
  };
  const readLote = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes).where(eq(lotes.id, loteId)),
    ).then((rows) => rows[0]);
  const readDoc = (cdc: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.cdc, cdc)),
    ).then((rows) => rows[0]);
  /**
   * Makes a document "already resent once", the way the guard lets it happen: queued again through
   * the door with an old stamp (before its lote existed, so that lote still owns it), then sent again.
   */
  async function markResent(cdc?: string) {
    const rows = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents),
    );
    const waiting = rows.filter(
      (r) =>
        ['queued', 'submitted'].includes(r.status) &&
        r.transmissionHold === null &&
        r.resentAt === null,
    );
    for (const row of waiting.filter((r) => cdc === undefined || r.cdc === cdc)) {
      await withTenantTransaction(handle.db, tenantId, async (tx) => {
        await tx
          .update(documents)
          .set({
            status: 'queued',
            resentAt: new Date('2026-01-01T00:00:00Z'),
            transmissionAttempts: row.transmissionAttempts + 1,
          })
          .where(eq(documents.id, row.id));
        if (row.status === 'submitted') {
          await tx.update(documents).set({ status: 'submitted' }).where(eq(documents.id, row.id));
        }
      });
    }
  }

  const approval = (cdc: string) => ({
    cdc,
    status: 'approved' as const,
    messages: [{ code: '0422', message: 'CDC encontrado' }],
  });
  const recovered: LoteRecoveryOutcome = {
    resolutions: [approval(CDC_A), approval(CDC_B)],
    unresolved: [],
  };

  it('loads the recovery lote with its last query time and still-submitted CDCs', async () => {
    const state = await storeFor(tenantId).load(loteId);
    expect(state).toMatchObject({ loteId, status: 'recovery', lastPolledAt: HANDED_OVER_AT });
    expect([...(state?.cdcs ?? [])].sort()).toEqual([CDC_A, CDC_B]);
  });

  it('lists only the CDCs that are still submitted', async () => {
    await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.update(documents).set({ status: 'approved' }).where(eq(documents.cdc, CDC_A)),
    );
    expect((await storeFor(tenantId).load(loteId))?.cdcs).toEqual([CDC_B]);
  });

  it('does not load an unknown lote or one of another tenant', async () => {
    expect(await storeFor(tenantId).load('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await storeFor(otherTenantId).load(loteId)).toBeNull();
  });

  it('approves every document and marks the lote processed in one transaction', async () => {
    expect(await storeFor(tenantId).record(loteId, recovered, guard)).toBe(true);
    expect(await readLote()).toMatchObject({
      status: 'processed',
      lastPolledAt: RECOVERED_AT,
      lastPollMessage: null,
    });
    expect(await readDoc(CDC_A)).toMatchObject({
      status: 'approved',
      sifenMessages: [{ code: '0422', message: 'CDC encontrado' }],
    });
    expect((await readDoc(CDC_B)).status).toBe('approved');
  });

  it('keeps the lote in recovery while a CDC is unresolved and stamps the query', async () => {
    const applied = await storeFor(tenantId).record(
      loteId,
      {
        resolutions: [approval(CDC_A)],
        unresolved: [{ cdc: CDC_B, reason: '0420: CDC inexistente' }],
      },
      guard,
    );
    expect(applied).toBe(true);
    expect(await readLote()).toMatchObject({
      status: 'recovery',
      lastPolledAt: RECOVERED_AT,
      lastPollMessage: expect.stringContaining('1') as string,
    });
    expect((await readDoc(CDC_A)).status).toBe('approved');
    expect((await readDoc(CDC_B)).status).toBe('submitted');
  });

  it('writes nothing when last_polled_at changed since the load', async () => {
    const applied = await storeFor(tenantId).record(loteId, recovered, {
      ...guard,
      expectedLastPolledAt: new Date('2026-10-03T12:00:00.000Z'),
    });
    expect(applied).toBe(false);
    expect((await readLote()).status).toBe('recovery');
    expect((await readDoc(CDC_A)).status).toBe('submitted');
  });

  it('matches last_polled_at stored with microseconds, and a null one', async () => {
    await handle.db.execute(
      sql`update lotes set last_polled_at = '2026-10-03 12:05:00.123456+00' where id = ${loteId}`,
    );
    const store = storeFor(tenantId);
    const state = await store.load(loteId);
    expect(state?.lastPolledAt).toEqual(new Date('2026-10-03T12:05:00.123Z'));
    expect(
      await store.record(loteId, recovered, {
        ...guard,
        expectedLastPolledAt: state?.lastPolledAt ?? null,
      }),
    ).toBe(true);
  });

  it('matches a lote that was never queried', async () => {
    await handle.db.execute(sql`update lotes set last_polled_at = null where id = ${loteId}`);
    expect(
      await storeFor(tenantId).record(loteId, recovered, { ...guard, expectedLastPolledAt: null }),
    ).toBe(true);
  });

  it('writes nothing when the lote is no longer in recovery', async () => {
    const store = storeFor(tenantId);
    await store.record(loteId, recovered, guard);
    expect(await store.record(loteId, recovered, guard)).toBe(false);
  });

  it('lets only one of two concurrent records win', async () => {
    const store = storeFor(tenantId);
    const results = await Promise.all([
      store.record(loteId, recovered, guard),
      store.record(loteId, recovered, guard),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not write for another tenant', async () => {
    expect(await storeFor(otherTenantId).record(loteId, recovered, guard)).toBe(false);
    expect((await readLote()).status).toBe('recovery');
  });

  it('rolls the lote back when a document is not submitted', async () => {
    await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.update(documents).set({ status: 'cancelled' }).where(eq(documents.cdc, CDC_B)),
    );
    await expect(storeFor(tenantId).record(loteId, recovered, guard)).rejects.toThrow(CDC_B);
    expect((await readLote()).status).toBe('recovery');
    expect((await readDoc(CDC_A)).status).toBe('submitted');
  });

  it('enqueues one document.approved event per settled document in the same transaction', async () => {
    await seedWebhookEndpoint(handle.db, tenantId);
    await storeFor(tenantId).record(loteId, recovered, guard);
    const deliveries = await handle.db.select().from(webhookDeliveries);
    expect(deliveries.map((d) => d.eventType)).toEqual(['document.approved', 'document.approved']);
  });

  /** A second lote (inserted directly, in any status) with its own documents. */
  async function seedLote(
    status: string,
    documentStatus: string,
    cdcs: string[],
    createdAt?: Date,
  ) {
    const { db } = handle;
    const [est] = await db.select().from(tenantEstablishments);
    const [point] = await db.select().from(tenantExpeditionPoints);
    const [timbrado] = await db.select().from(tenantTimbrados);
    const docs = await db
      .insert(documents)
      .values(
        cdcs.map((cdc, i) => ({
          tenantId,
          environment: 'test' as const,
          timbradoId: timbrado.id,
          establishmentId: est.id,
          expeditionPointId: point.id,
          documentType: 1,
          number: 100 + i,
          cdc,
          securityCode: '123456789',
          status: documentStatus,
          issuedAt: new Date('2026-01-01T12:00:00Z'),
          totalAmount: '110000',
          payload: {},
        })),
      )
      .returning();
    const [lote] = await db
      .insert(lotes)
      .values({
        tenantId,
        environment: 'test',
        documentType: 1,
        status,
        ...(createdAt ? { createdAt } : {}),
        lastPollMessage: status === 'processed' ? '1 document(s) need recovery' : null,
      })
      .returning();
    await db
      .insert(loteDocuments)
      .values(docs.map((d) => ({ tenantId, loteId: lote.id, documentId: d.id })));
    return lote.id;
  }
  const CDC_C = '01800695631001001000000312026010111234567893';
  const CDC_D = '01800695631001001000000412026010111234567894';
  const readLoteById = (id: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes).where(eq(lotes.id, id)),
    ).then((rows) => rows[0]);
  const unknownGuard = { ...guard, expectedStatus: 'unknown', expectedLastPolledAt: null };

  describe('lote sent without an answer (unknown)', () => {
    it('loads the queued CDCs: SIFEN may hold them although the send was never confirmed', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C, CDC_D]);
      const state = await storeFor(tenantId).load(unknown);
      expect(state).toMatchObject({ status: 'unknown', lastPolledAt: null });
      expect([...(state?.cdcs ?? [])].sort()).toEqual([CDC_C, CDC_D]);
    });

    it('approves a found CDC through submitted, with both events, and closes the lote', async () => {
      await seedWebhookEndpoint(handle.db, tenantId);
      const unknown = await seedLote('unknown', 'queued', [CDC_C, CDC_D]);
      const applied = await storeFor(tenantId).record(
        unknown,
        { resolutions: [approval(CDC_C), approval(CDC_D)], unresolved: [] },
        unknownGuard,
      );
      expect(applied).toBe(true);
      expect(await readLoteById(unknown)).toMatchObject({ status: 'processed' });
      expect((await readDoc(CDC_C)).status).toBe('approved');
      const events = await handle.db.select().from(webhookDeliveries);
      expect(events.map((e) => e.eventType).sort()).toEqual([
        'document.approved',
        'document.approved',
        'document.submitted',
        'document.submitted',
      ]);
    });

    it('keeps the lote unknown while a CDC is unresolved and leaves that document queued', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C, CDC_D]);
      await storeFor(tenantId).record(
        unknown,
        { resolutions: [approval(CDC_C)], unresolved: [{ cdc: CDC_D, reason: '0420' }] },
        unknownGuard,
      );
      expect((await readLoteById(unknown)).status).toBe('unknown');
      expect((await readDoc(CDC_C)).status).toBe('approved');
      expect((await readDoc(CDC_D)).status).toBe('queued');
    });

    it('recovers a mixed 0422 / 0420 lote end to end: one approved, one left queued, lote unknown', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C, CDC_D]);
      // The pass asks the least recently queried first: pin C before D so the scripted answers line up.
      await handle.db.execute(
        sql`update documents set updated_at = '2026-09-01T00:00:00Z' where cdc = ${CDC_C}`,
      );
      await handle.db.execute(
        sql`update documents set updated_at = '2026-09-02T00:00:00Z' where cdc = ${CDC_D}`,
      );
      const gateway = new FakeSifenGateway();
      gateway.enqueue(
        'consultarDE',
        sifenScenarios.cdcEncontrado(`<rDE><DE Id="${CDC_C}"/></rDE>`),
        sifenScenarios.cdcInexistente(),
      );
      let dId = 0n;
      const recover = new RecoverLoteByCdc({
        gateway,
        store: storeFor(tenantId),
        nextRequestId: () => Promise.resolve((dId += 1n)),
        now: () => RECOVERED_AT,
      });
      expect(await recover.execute({ loteId: unknown })).toMatchObject({ status: 'incomplete' });
      expect((await readDoc(CDC_C)).status).toBe('approved');
      expect((await readDoc(CDC_D)).status).toBe('queued');
      expect((await readLoteById(unknown)).status).toBe('unknown');
      expect(gateway.callsTo('enviarLote')).toHaveLength(0);
    });

    it('rolls everything back when a later settlement fails after a document was confirmed', async () => {
      await seedWebhookEndpoint(handle.db, tenantId);
      const unknown = await seedLote('unknown', 'queued', [CDC_C]);
      await expect(
        storeFor(tenantId).record(
          unknown,
          { resolutions: [approval(CDC_C), approval(CDC_D)], unresolved: [] },
          unknownGuard,
        ),
      ).rejects.toThrow(CDC_D);
      expect((await readDoc(CDC_C)).status).toBe('queued');
      expect((await readLoteById(unknown)).status).toBe('unknown');
      expect(await handle.db.select().from(webhookDeliveries)).toEqual([]);
    });

    it('writes nothing when the expected status is not the lote status', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C]);
      expect(
        await storeFor(tenantId).record(
          unknown,
          { resolutions: [approval(CDC_C)], unresolved: [] },
          { ...unknownGuard, expectedStatus: 'recovery' },
        ),
      ).toBe(false);
      expect((await readDoc(CDC_C)).status).toBe('queued');
    });
  });

  describe('lote processed with documents left submitted', () => {
    it('loads the submitted CDCs and settles them, keeping the lote processed', async () => {
      const done = await seedLote('processed', 'submitted', [CDC_C, CDC_D]);
      const store = storeFor(tenantId);
      expect([...((await store.load(done))?.cdcs ?? [])].sort()).toEqual([CDC_C, CDC_D]);
      const processedGuard = { ...guard, expectedStatus: 'processed', expectedLastPolledAt: null };
      await store.record(
        done,
        { resolutions: [approval(CDC_C)], unresolved: [{ cdc: CDC_D, reason: '0420' }] },
        processedGuard,
      );
      expect((await readLoteById(done)).status).toBe('processed');
      expect((await readDoc(CDC_C)).status).toBe('approved');
      expect((await store.load(done))?.cdcs).toEqual([CDC_D]);
    });
  });

  describe('hand-over reason', () => {
    it('is kept when a pass leaves CDCs unresolved, without piling up, and when it settles them', async () => {
      await handle.db.execute(
        sql`update lotes set last_poll_message = '0364: Consulta extemporanea' where id = ${loteId}`,
      );
      const store = storeFor(tenantId);
      const pending = { resolutions: [approval(CDC_A)], unresolved: [{ cdc: CDC_B, reason: 'x' }] };
      await store.record(loteId, pending, guard);
      const first = (await readLote()).lastPollMessage ?? '';
      expect(first).toContain('0364: Consulta extemporanea');
      expect(first).toContain('1 document(s) still unresolved');

      await store.record(
        loteId,
        { resolutions: [], unresolved: [{ cdc: CDC_B, reason: 'x' }] },
        {
          ...guard,
          expectedLastPolledAt: RECOVERED_AT,
          recoveredAt: new Date('2026-10-03T12:30:00Z'),
        },
      );
      const second = (await readLote()).lastPollMessage ?? '';
      expect(second.match(/0364: Consulta extemporanea/g)).toHaveLength(1);
      expect(second.match(/still unresolved/g)).toHaveLength(1);

      await store.record(
        loteId,
        { resolutions: [approval(CDC_B)], unresolved: [] },
        {
          ...guard,
          expectedLastPolledAt: new Date('2026-10-03T12:30:00Z'),
          recoveredAt: new Date('2026-10-03T12:45:00Z'),
        },
      );
      expect(await readLote()).toMatchObject({
        status: 'processed',
        lastPollMessage: '0364: Consulta extemporanea',
      });
    });
  });

  describe('a CDC that answers 0420 after the 48 h window (hold and alert)', () => {
    const absent = (cdc: string) => ({ cdc, reason: '0420: CDC inexistente', absent: true });
    const AFTER_WINDOW = new Date(SENT_AT.getTime() + 48 * 3_600_000);
    // Documents already resent once: a second 0420 past the window holds them (it never resends twice).
    beforeEach(async () => {
      await markResent();
    });
    const setAttempts = (cdc: string, attempts: number) =>
      withTenantTransaction(handle.db, tenantId, (tx) =>
        tx.update(documents).set({ transmissionAttempts: attempts }).where(eq(documents.cdc, cdc)),
      );

    it('audits each hold in the same transaction, as the system actor', async () => {
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
        guard,
      );
      const audits = await handle.db.select().from(auditLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorType: 'system',
        actorId: 'transmission-worker',
        action: 'document.hold_placed',
        entityType: 'document',
        before: { transmissionHold: null },
        after: { transmissionHold: RECOVERY_AFTER_RESEND_HOLD },
      });
      expect(audits[0].entityId).toBe((await readDoc(CDC_B)).id);
    });

    it('does every document UPDATE before the first audit insert, like the release path', async () => {
      const statements: string[] = [];
      const logged = drizzle((handle.db as unknown as { $client: never }).$client, {
        logger: { logQuery: (query) => statements.push(query) },
      });
      const spied = createDrizzleLoteRecoveryStore({
        db: logged as unknown as typeof handle.db,
        tenantId,
      });
      await spied.record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_A), absent(CDC_B)] },
        guard,
      );

      const lastDocumentUpdate = statements.reduce(
        (last, query, index) => (/^update "documents"/i.test(query) ? index : last),
        -1,
      );
      const firstAudit = statements.findIndex((q) => /^insert into "audit_log"/i.test(q));
      expect(firstAudit).toBeGreaterThan(-1);
      expect(statements.filter((q) => /^insert into "audit_log"/i.test(q))).toHaveLength(2);
      expect(lastDocumentUpdate).toBeLessThan(firstAudit);
    });

    it('rolls the hold back when its audit row cannot be written (characterization)', async () => {
      await handle.db.execute(sql`
        create function fail_hold_audit() returns trigger language plpgsql as $$
        begin
          if new.action = 'document.hold_placed' then
            raise exception 'audit down';
          end if;
          return new;
        end $$`);
      await handle.db.execute(
        sql`create trigger fail_hold_audit before insert on audit_log for each row execute function fail_hold_audit()`,
      );
      await expect(
        storeFor(tenantId).record(
          loteId,
          { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
          guard,
        ),
      ).rejects.toThrow();
      expect((await readDoc(CDC_B)).transmissionHold).toBeNull();
      expect((await readDoc(CDC_A)).status).toBe('submitted');
      expect((await readLote()).status).toBe('recovery');
      expect(warnings).toEqual([]);
    });

    it('writes no audit row when nothing is held or the record is rolled back', async () => {
      const store = storeFor(tenantId);
      await store.record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        { ...guard, recoveredAt: new Date(SENT_AT.getTime() + 3_600_000) },
      );
      expect(await handle.db.select().from(auditLog)).toEqual([]);

      await withTenantTransaction(handle.db, tenantId, (tx) =>
        tx.update(documents).set({ status: 'cancelled' }).where(eq(documents.cdc, CDC_A)),
      );
      await expect(
        store.record(
          loteId,
          { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
          { ...guard, expectedLastPolledAt: new Date(SENT_AT.getTime() + 3_600_000) },
        ),
      ).rejects.toThrow(CDC_A);
      expect(await handle.db.select().from(auditLog)).toEqual([]);
    });

    it('holds the document at the first 0420 once 48 h passed since the send, and warns', async () => {
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
        guard,
      );
      expect(await readDoc(CDC_B)).toMatchObject({
        transmissionHold: RECOVERY_AFTER_RESEND_HOLD,
        status: 'submitted',
      });
      expect(RECOVERY_AFTER_RESEND_HOLD).toBe('recovery:0420-after-resend');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(RECOVERY_AFTER_RESEND_HOLD);
    });

    it('does not hold at 47 h 59 min 59.999 s since the send, and holds at exactly 48 h', async () => {
      const store = storeFor(tenantId);
      await store.record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        { ...guard, recoveredAt: new Date(AFTER_WINDOW.getTime() - 1) },
      );
      expect((await readDoc(CDC_B)).transmissionHold).toBeNull();
      await store.record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        {
          ...guard,
          expectedLastPolledAt: new Date(AFTER_WINDOW.getTime() - 1),
          recoveredAt: AFTER_WINDOW,
        },
      );
      expect((await readDoc(CDC_B)).transmissionHold).toBe(RECOVERY_AFTER_RESEND_HOLD);
    });

    it('never touches transmission_attempts: that counter belongs to the 0301 backoff', async () => {
      await setAttempts(CDC_B, 4);
      const store = storeFor(tenantId);
      await store.record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        { ...guard, recoveredAt: new Date(SENT_AT.getTime() + 3_600_000) },
      );
      expect((await readDoc(CDC_B)).transmissionAttempts).toBe(4);
      await store.record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        {
          ...guard,
          expectedLastPolledAt: new Date(SENT_AT.getTime() + 3_600_000),
          recoveredAt: AFTER_WINDOW,
        },
      );
      expect(await readDoc(CDC_B)).toMatchObject({
        transmissionAttempts: 4,
        transmissionHold: RECOVERY_AFTER_RESEND_HOLD,
      });
      // A was only marked resent once (attempt 1): the hold of B did not touch it.
      expect((await readDoc(CDC_A)).transmissionAttempts).toBe(1);
    });

    it('ignores failures and odd answers: they are not 0420 and never hold', async () => {
      await storeFor(tenantId).record(
        loteId,
        {
          resolutions: [],
          unresolved: [{ cdc: CDC_B, reason: 'Query failed (SifenTimeoutError)', absent: false }],
        },
        guard,
      );
      expect((await readDoc(CDC_B)).transmissionHold).toBeNull();
    });

    it('settles the lote when every document left is held, so it stops being queried', async () => {
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
        guard,
      );
      expect(await readLote()).toMatchObject({ status: 'processed' });
      expect((await readLote()).lastPollMessage).toBe(
        `held for an operator (${RECOVERY_AFTER_RESEND_HOLD})`,
      );
      expect((await storeFor(tenantId).load(loteId))?.cdcs).toEqual([]);
    });

    it('keeps the hand-over reason, and drops a bare recovery note, in the settled lote message', async () => {
      await handle.db.execute(
        sql`update lotes set last_poll_message = '0364: tarde | recovery: 2 document(s) still unresolved by CDC query' where id = ${loteId}`,
      );
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
        guard,
      );
      expect((await readLote()).lastPollMessage).toBe(
        `0364: tarde | held for an operator (${RECOVERY_AFTER_RESEND_HOLD})`,
      );

      const second = await seedLote('recovery', 'submitted', [CDC_C], SENT_AT);
      await markResent();
      await handle.db.execute(
        sql`update lotes set last_poll_message = 'recovery: 1 document(s) still unresolved by CDC query' where id = ${second}`,
      );
      await storeFor(tenantId).record(
        second,
        { resolutions: [], unresolved: [absent(CDC_C)] },
        { ...guard, expectedLastPolledAt: null },
      );
      // That lote has no send instant (legacy): its document is held, never resent.
      expect((await readLoteById(second)).lastPollMessage).toBe(
        `held for an operator (${RECOVERY_UNRESOLVED_HOLD})`,
      );
    });

    it('keeps the lote in recovery while a document is neither resolved nor held', async () => {
      await storeFor(tenantId).record(
        loteId,
        {
          resolutions: [],
          unresolved: [
            absent(CDC_A),
            { cdc: CDC_B, reason: 'Query failed (SifenTimeoutError)', absent: false },
          ],
        },
        guard,
      );
      expect((await readDoc(CDC_A)).transmissionHold).toBe(RECOVERY_AFTER_RESEND_HOLD);
      expect((await readDoc(CDC_B)).transmissionHold).toBeNull();
      expect((await readLote()).status).toBe('recovery');
      expect((await storeFor(tenantId).load(loteId))?.cdcs).toEqual([CDC_B]);
    });

    it('counts the 48 h from the send attempt, not from the lote creation (pending for days, then sent)', async () => {
      // Created 100 h before the pass, claimed (send attempted, timed out) only 1 h before it.
      const created = new Date(RECOVERED_AT.getTime() - 100 * 3_600_000);
      const unknown = await seedLote('unknown', 'queued', [CDC_C], created);
      await handle.db.execute(
        sql`update lotes set send_attempted_at = ${new Date(RECOVERED_AT.getTime() - 3_600_000)} where id = ${unknown}`,
      );
      await storeFor(tenantId).record(
        unknown,
        { resolutions: [], unresolved: [absent(CDC_C)] },
        unknownGuard,
      );
      expect((await readDoc(CDC_C)).transmissionHold).toBeNull();
      expect((await readLoteById(unknown)).status).toBe('unknown');
    });

    it('resends once 48 h passed since the send attempt', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C], SENT_AT);
      await handle.db.execute(
        sql`update lotes set send_attempted_at = ${new Date(RECOVERED_AT.getTime() - 48 * 3_600_000)} where id = ${unknown}`,
      );
      await storeFor(tenantId).record(
        unknown,
        { resolutions: [], unresolved: [absent(CDC_C)] },
        unknownGuard,
      );
      expect(await readDoc(CDC_C)).toMatchObject({
        transmissionHold: null,
        transmissionAttempts: 1,
      });
      expect((await readDoc(CDC_C)).resentAt).not.toBeNull();
    });

    it('holds a queued document of a legacy unknown lote (no send attempt instant), from its creation', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C], SENT_AT);
      await storeFor(tenantId).record(
        unknown,
        { resolutions: [], unresolved: [absent(CDC_C)] },
        unknownGuard,
      );
      expect(await readDoc(CDC_C)).toMatchObject({
        status: 'queued',
        transmissionHold: RECOVERY_UNRESOLVED_HOLD,
      });
      expect((await readLoteById(unknown)).status).toBe('processed');
    });

    it('writes no hold when the record loses the compare-and-set', async () => {
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        { ...guard, expectedLastPolledAt: new Date('2026-10-03T12:00:00.000Z') },
      );
      expect((await readDoc(CDC_B)).transmissionHold).toBeNull();
      expect(warnings).toEqual([]);
    });
  });

  describe('bounded passes', () => {
    it('leaves skipped CDCs untouched and the lote open, and touches the ones it did query', async () => {
      await storeFor(tenantId).record(
        loteId,
        {
          resolutions: [],
          unresolved: [
            { cdc: CDC_A, reason: '0420: CDC inexistente', absent: false },
            { cdc: CDC_B, reason: 'Not queried in this pass', skipped: true },
          ],
        },
        guard,
      );
      expect((await readDoc(CDC_A)).updatedAt).toEqual(RECOVERED_AT);
      expect((await readDoc(CDC_B)).updatedAt).not.toEqual(RECOVERED_AT);
      expect((await readLote()).status).toBe('recovery');
    });

    it('loads the least recently queried CDCs first, so a capped pass rotates through the lote', async () => {
      await handle.db.execute(sql`update documents set updated_at = '2026-09-01T00:00:00Z'`);
      await storeFor(tenantId).record(
        loteId,
        {
          resolutions: [],
          unresolved: [
            { cdc: CDC_A, reason: 'x', absent: false },
            { cdc: CDC_B, reason: 'Not queried in this pass', skipped: true },
          ],
        },
        guard,
      );
      expect((await storeFor(tenantId).load(loteId))?.cdcs).toEqual([CDC_B, CDC_A]);
    });
  });

  describe('capped passes over time', () => {
    it('ask every CDC across passes even when none of them ever resolves (maxQueries 1)', async () => {
      await handle.db.execute(
        sql`update documents set updated_at = '2026-09-01T00:00:00Z' where cdc = ${CDC_A}`,
      );
      await handle.db.execute(
        sql`update documents set updated_at = '2026-09-02T00:00:00Z' where cdc = ${CDC_B}`,
      );
      const gateway = new FakeSifenGateway();
      gateway.setDefault('consultarDE', new Error('SIFEN unavailable'));
      let now = RECOVERED_AT;
      let dId = 0n;
      const recover = new RecoverLoteByCdc({
        gateway,
        store: storeFor(tenantId),
        nextRequestId: () => Promise.resolve((dId += 1n)),
        now: () => now,
        maxQueries: 1,
      });

      await recover.execute({ loteId });
      now = new Date(now.getTime() + 11 * 60_000);
      await recover.execute({ loteId });
      now = new Date(now.getTime() + 11 * 60_000);
      await recover.execute({ loteId });

      expect(gateway.callsTo('consultarDE').map(([request]) => request.cdc)).toEqual([
        CDC_A,
        CDC_B,
        CDC_A,
      ]);
    });
  });

  describe('a failing alert', () => {
    it('cannot fail the record after the commit: the hold stays and record still returns true', async () => {
      await markResent();
      const failing = createDrizzleLoteRecoveryStore({
        db: handle.db,
        tenantId,
        logger: {
          warn: () => {
            throw new Error('logger down');
          },
        },
      });
      const applied = await failing.record(
        loteId,
        {
          resolutions: [approval(CDC_A)],
          unresolved: [{ cdc: CDC_B, reason: '0420', absent: true }],
        },
        guard,
      );
      expect(applied).toBe(true);
      expect((await readDoc(CDC_B)).transmissionHold).toBe(RECOVERY_AFTER_RESEND_HOLD);
    });
  });

  describe('the audited resend after a post-window 0420 (HU-E6-04, option B)', () => {
    const absent = (cdc: string) => ({ cdc, reason: '0420: CDC inexistente', absent: true });
    const setAttempts = (cdc: string, attempts: number) =>
      withTenantTransaction(handle.db, tenantId, (tx) =>
        tx.update(documents).set({ transmissionAttempts: attempts }).where(eq(documents.cdc, cdc)),
      );

    it('queues the submitted document again, stamped and counted, instead of holding it', async () => {
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
        guard,
      );
      const resent = await readDoc(CDC_B);
      expect(resent).toMatchObject({
        status: 'queued',
        transmissionAttempts: 1,
        transmissionHold: null,
        cdc: CDC_B,
      });
      expect(resent.resentAt).not.toBeNull();
      expect(warnings).toEqual([]);
    });

    it('audits the resend as the system actor in the same transaction', async () => {
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        guard,
      );
      const audits = await handle.db.select().from(auditLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorType: 'system',
        actorId: 'transmission-worker',
        action: 'document.resend_queued',
        entityType: 'document',
        before: { status: 'submitted', transmissionAttempts: 0 },
        after: { status: 'queued', transmissionAttempts: 1 },
      });
      expect(audits[0].entityId).toBe((await readDoc(CDC_B)).id);
    });

    it('settles the lote once every document is approved, held or waiting to be resent', async () => {
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
        guard,
      );
      expect(await readLote()).toMatchObject({ status: 'processed' });
      expect((await storeFor(tenantId).load(loteId))?.cdcs).toEqual([]);
    });

    it('keeps the CDC, and never asks again for a document waiting to be resent', async () => {
      await storeFor(tenantId).record(
        loteId,
        {
          resolutions: [],
          unresolved: [
            absent(CDC_A),
            { cdc: CDC_B, reason: 'Query failed (SifenTimeoutError)', absent: false },
          ],
        },
        guard,
      );
      expect((await readDoc(CDC_A)).status).toBe('queued');
      expect((await readLote()).status).toBe('recovery');
      expect((await storeFor(tenantId).load(loteId))?.cdcs).toEqual([CDC_B]);
    });

    it('stamps a queued document of an unknown lote and leaves its lote', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C], SENT_AT);
      await handle.db.execute(
        sql`update lotes set send_attempted_at = ${SENT_AT} where id = ${unknown}`,
      );
      await storeFor(tenantId).record(
        unknown,
        { resolutions: [], unresolved: [absent(CDC_C)] },
        unknownGuard,
      );
      const resent = await readDoc(CDC_C);
      expect(resent).toMatchObject({ status: 'queued', transmissionAttempts: 1 });
      expect(resent.resentAt).not.toBeNull();
      expect((await readLoteById(unknown)).status).toBe('processed');
    });

    it('holds, never resends, a document that was already resent once', async () => {
      await markResent(CDC_B);
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        guard,
      );
      expect(await readDoc(CDC_B)).toMatchObject({
        status: 'submitted',
        transmissionHold: RECOVERY_AFTER_RESEND_HOLD,
        transmissionAttempts: 1,
      });
    });

    it('applies the attempt cap of the 0301 backoff: at the last attempt it holds instead', async () => {
      await setAttempts(CDC_A, 3);
      await setAttempts(CDC_B, 4);
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_A), absent(CDC_B)] },
        guard,
      );
      expect(await readDoc(CDC_A)).toMatchObject({ status: 'queued', transmissionAttempts: 4 });
      expect(await readDoc(CDC_B)).toMatchObject({
        status: 'submitted',
        transmissionAttempts: 4,
        transmissionHold: RECOVERY_ATTEMPTS_EXHAUSTED_HOLD,
      });
    });

    it('never resends before 48 h since the send, nor on an answer that is not 0420', async () => {
      const store = storeFor(tenantId);
      await store.record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_A)] },
        { ...guard, recoveredAt: new Date(SENT_AT.getTime() + 48 * 3_600_000 - 1) },
      );
      await store.record(
        loteId,
        {
          resolutions: [],
          unresolved: [{ cdc: CDC_B, reason: 'Query failed (SifenTimeoutError)', absent: false }],
        },
        { ...guard, expectedLastPolledAt: new Date(SENT_AT.getTime() + 48 * 3_600_000 - 1) },
      );
      expect(await readDoc(CDC_A)).toMatchObject({ status: 'submitted', resentAt: null });
      expect(await readDoc(CDC_B)).toMatchObject({ status: 'submitted', resentAt: null });
    });

    it('leaves a document that a newer lote carries to that lote', async () => {
      const [doc] = await handle.db.select().from(documents).where(eq(documents.cdc, CDC_B));
      const [newer] = await handle.db
        .insert(lotes)
        .values({
          tenantId,
          environment: 'test',
          documentType: 1,
          status: 'sent',
          sentAt: RECOVERED_AT,
        })
        .returning();
      await handle.db
        .insert(loteDocuments)
        .values({ tenantId, loteId: newer.id, documentId: doc.id });

      expect((await storeFor(tenantId).load(loteId))?.cdcs).toEqual([CDC_A]);
      await storeFor(tenantId).record(
        loteId,
        { resolutions: [], unresolved: [absent(CDC_B)] },
        guard,
      );
      expect(await readDoc(CDC_B)).toMatchObject({ status: 'submitted', resentAt: null });
    });

    it('rolls the resend back when its audit row cannot be written', async () => {
      await handle.db.execute(sql`
        create function fail_resend_audit() returns trigger language plpgsql as $$
        begin
          if new.action = 'document.resend_queued' then raise exception 'audit down'; end if;
          return new;
        end $$`);
      await handle.db.execute(
        sql`create trigger fail_resend_audit before insert on audit_log for each row execute function fail_resend_audit()`,
      );
      await expect(
        storeFor(tenantId).record(
          loteId,
          { resolutions: [approval(CDC_A)], unresolved: [absent(CDC_B)] },
          guard,
        ),
      ).rejects.toThrow();
      expect(await readDoc(CDC_B)).toMatchObject({ status: 'submitted', resentAt: null });
      expect((await readDoc(CDC_A)).status).toBe('submitted');
      expect((await readLote()).status).toBe('recovery');
    });
  });
});
