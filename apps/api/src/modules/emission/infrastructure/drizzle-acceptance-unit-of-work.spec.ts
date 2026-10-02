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
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { createAcceptInvoice, IssuerNotConfiguredError } from '../application/accept-invoice.js';
import type { AcceptInvoiceInput } from '../application/accept-invoice.js';
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
});
