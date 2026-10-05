import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  webhookDeliveries,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { seedWebhookEndpoint } from '../../../../test/support/document-seed.js';
import {
  createAcceptInvoice,
  IdempotencyKeyReusedError,
  IssuerNotConfiguredError,
} from '../application/accept-invoice.js';
import type { AcceptInvoiceInput } from '../application/accept-invoice.js';
import { IdempotencyKeyCollisionError } from '../application/ports/acceptance-unit-of-work.port.js';
import { parseCdc } from '../domain/cdc.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';

const DRAFT: AcceptInvoiceInput['draft'] = {
  receiver: { kind: 'named', isPublicEntity: false },
  operationType: 'B2B',
  items: [{ quantity: 1, unitPrice: 110_000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

/** Spec: HU-E5-01 (S2). Persistence adapter for AcceptInvoice, against a real (pglite) database. */
describe('AcceptInvoice with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let keySeq = 0;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
    await handle.db.insert(tenantFiscalProfiles).values({
      tenantId,
      rucBase: '80069563',
      rucDv: 1,
      legalName: 'Empresa SA',
      taxpayerType: 'persona_juridica',
    });
    const [est] = await handle.db
      .insert(tenantEstablishments)
      .values({
        tenantId,
        code: '001',
        address: 'Av. Mariscal Lopez 123',
        houseNumber: '123',
        departmentCode: '11',
        cityCode: '3432',
        cityDescription: 'Asuncion',
      })
      .returning();
    await handle.db
      .insert(tenantExpeditionPoints)
      .values({ tenantId, establishmentId: est.id, code: '002' });
    await handle.db.insert(tenantTimbrados).values([
      { tenantId, number: '11111111', validFrom: '2024-01-01', validTo: '2025-12-31' },
      { tenantId, number: '22222222', validFrom: '2026-01-01' },
    ]);
  });

  afterEach(async () => {
    await handle.close();
  });

  const accept = (now = '2026-03-06T01:30:00Z') =>
    createAcceptInvoice({
      unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
      now: () => new Date(now),
    });

  const input = (overrides: Partial<AcceptInvoiceInput> = {}): AcceptInvoiceInput => ({
    tenantId,
    actor: { type: 'api_key', id: 'key-1' },
    establishmentCode: '001',
    expeditionPointCode: '002',
    draft: DRAFT,
    receiverRuc: null,
    payload: { items: 1 },
    idempotencyKey: `key-${String(++keySeq)}`,
    ...overrides,
  });

  const rows = () =>
    withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents));

  it('persists consecutive accepted documents under the active timbrado', async () => {
    const first = await accept()(input());
    const second = await accept()(input());

    const stored = await rows();
    expect(stored.map((r) => [r.number, r.status]).sort()).toEqual([
      [1, 'accepted'],
      [2, 'accepted'],
    ]);
    expect(stored.find((r) => r.id === first.documentId)?.cdc).toBe(first.cdc);
    expect(parseCdc(second.cdc)).toMatchObject({ documentNumber: '0000002', point: '002' });
    const [timbrado] = await handle.db
      .select()
      .from(tenantTimbrados)
      .where(eq(tenantTimbrados.number, '22222222'));
    expect(stored.every((r) => r.timbradoId === timbrado.id)).toBe(true);
  });

  it('writes the audit row in the same transaction', async () => {
    const { documentId } = await accept()(input());
    const audit = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'document.accepted', entityId: documentId });
  });

  it('burns no number when the draft is invalid', async () => {
    await expect(accept()(input({ draft: { ...DRAFT, items: [] } }))).rejects.toThrow();
    await accept()(input());
    expect((await rows()).map((r) => r.number)).toEqual([1]);
  });

  it('rejects an unknown point and a tenant without fiscal setup', async () => {
    await expect(accept()(input({ expeditionPointCode: '009' }))).rejects.toBeInstanceOf(
      IssuerNotConfiguredError,
    );
    await expect(accept()(input({ tenantId: otherTenantId }))).rejects.toBeInstanceOf(
      IssuerNotConfiguredError,
    );
    expect(await rows()).toHaveLength(0);
  });

  it('rejects an issue date outside every timbrado validity', async () => {
    await expect(accept('2023-06-01T12:00:00Z')(input())).rejects.toBeInstanceOf(
      IssuerNotConfiguredError,
    );
  });

  it('uses the timbrado valid on the Paraguay issue date', async () => {
    // 2026-01-01T01:00Z is still 2025-12-31 in Paraguay: the expired-in-2026 timbrado applies.
    await accept('2026-01-01T01:00:00Z')(input());
    const [row] = await rows();
    const [old] = await handle.db
      .select()
      .from(tenantTimbrados)
      .where(eq(tenantTimbrados.number, '11111111'));
    expect(row.timbradoId).toBe(old.id);
  });

  describe('idempotency (HU-E5-02)', () => {
    it('replays the same response for the same key and payload, creating nothing new', async () => {
      const first = await accept()(input({ idempotencyKey: 'retry-me' }));
      const second = await accept()(input({ idempotencyKey: 'retry-me' }));

      expect(second).toEqual(first);
      expect(await rows()).toHaveLength(1);
      const audit = await withTenantTransaction(handle.db, tenantId, (tx) =>
        tx.select().from(auditLog),
      );
      expect(audit).toHaveLength(1);
      // The replay burned no number: the next new document is number 2.
      const next = await accept()(input());
      expect(parseCdc(next.cdc).documentNumber).toBe('0000002');
    });

    it('rejects the same key with a different payload and keeps the original', async () => {
      const first = await accept()(input({ idempotencyKey: 'k', payload: { a: 1 } }));
      await expect(
        accept()(input({ idempotencyKey: 'k', payload: { a: 2 } })),
      ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: first.documentId, idempotencyKey: 'k' });
    });

    it('treats the same payload with reordered keys as the same request', async () => {
      const first = await accept()(input({ idempotencyKey: 'k', payload: { a: 1, b: { c: 2 } } }));
      const second = await accept()(input({ idempotencyKey: 'k', payload: { b: { c: 2 }, a: 1 } }));
      expect(second).toEqual(first);
    });

    it('scopes keys per tenant: another tenant may reuse the same key', async () => {
      await accept()(input({ idempotencyKey: 'shared' }));
      await handle.db.insert(tenantFiscalProfiles).values({
        tenantId: otherTenantId,
        rucBase: '80069563',
        rucDv: 1,
        legalName: 'Otra SA',
        taxpayerType: 'persona_juridica',
      });
      const [est] = await handle.db
        .insert(tenantEstablishments)
        .values({
          tenantId: otherTenantId,
          code: '001',
          address: 'Av. Mariscal Lopez 123',
          houseNumber: '123',
          departmentCode: '11',
          cityCode: '3432',
          cityDescription: 'Asuncion',
        })
        .returning();
      await handle.db
        .insert(tenantExpeditionPoints)
        .values({ tenantId: otherTenantId, establishmentId: est.id, code: '002' });
      await handle.db
        .insert(tenantTimbrados)
        .values({ tenantId: otherTenantId, number: '33333333', validFrom: '2026-01-01' });

      const theirs = await accept()(input({ tenantId: otherTenantId, idempotencyKey: 'shared' }));

      expect(theirs.documentId).toBeDefined();
      expect(await rows()).toHaveLength(1);
    });

    it('raises a collision error when a concurrent insert reuses the key, rolling the number back', async () => {
      const unitOfWork = createDrizzleAcceptanceUnitOfWork(handle.db);
      await accept()(input({ idempotencyKey: 'race' }));

      const racing = unitOfWork.run(tenantId, async (unit) => {
        const issuer = await unit.resolveIssuer({
          establishmentCode: '001',
          expeditionPointCode: '002',
          issueDate: '2026-03-05',
        });
        if (!issuer) throw new Error('issuer expected');
        const { number } = await unit.nextNumber(issuer, 1);
        return unit.insertDocument({
          environment: issuer.environment,
          cdc: '9'.repeat(44),
          documentType: 1,
          timbradoId: issuer.timbradoId,
          establishmentId: issuer.establishmentId,
          expeditionPointId: issuer.expeditionPointId,
          series: '',
          number,
          securityCode: '123456789',
          receiverRuc: null,
          issuedAt: new Date('2026-03-06T01:30:00Z'),
          totalAmount: '1',
          currency: 'PYG',
          payload: {},
          idempotencyKey: 'race',
          requestHash: 'a'.repeat(64),
        });
      });

      await expect(racing).rejects.toBeInstanceOf(IdempotencyKeyCollisionError);
      expect((await accept()(input())).cdc).toSatisfy(
        (cdc: string) => parseCdc(cdc).documentNumber === '0000002',
      );
    });
  });

  it('enqueues a document.created event with the document (outbox)', async () => {
    await seedWebhookEndpoint(handle.db, tenantId);
    const { documentId, cdc } = await accept()(input());
    const [row] = await handle.db.select().from(webhookDeliveries);
    expect(row).toMatchObject({ tenantId, eventType: 'document.created', status: 'pending' });
    expect(row.payload).toMatchObject({
      data: { document_id: documentId, cdc, status: 'accepted' },
    });
  });
});
