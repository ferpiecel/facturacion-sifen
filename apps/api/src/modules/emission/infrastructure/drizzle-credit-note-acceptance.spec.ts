import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  documents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { IdempotencyKeyReusedError } from '../application/accept-invoice.js';
import {
  createAcceptCreditNote,
  type AcceptCreditNoteInput,
} from '../application/accept-credit-note.js';
import { InvoiceValidationError } from '../application/accept-invoice.js';
import { parseCdc } from '../domain/cdc.js';
import {
  acceptInvoiceWithStatus,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';

const ITEM = { quantity: 1, unitPrice: 400_000, vatRate: 10 as const };

/** Spec: HU-E7-01 T6 (ADR-0019). Acceptance of an NCE against a real (pglite) database. */
describe('AcceptCreditNote with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let keySeq = 0;
  let feCdc: string;
  let feId: string;

  const unitOfWork = () => createDrizzleAcceptanceUnitOfWork(handle.db);
  const acceptCredit = () =>
    createAcceptCreditNote({
      unitOfWork: unitOfWork(),
      now: () => new Date('2026-03-06T01:30:00Z'),
    });

  const acceptedInvoice = (owner: string, status = 'approved') =>
    acceptInvoiceWithStatus(handle.db, owner, `fe-${String(++keySeq)}`, status);

  async function advance(id: string, status: string) {
    const path: Record<string, string[]> = {
      signed: ['signed'],
      approved: ['signed', 'submitted', 'approved'],
      approved_with_observations: ['signed', 'submitted', 'approved_with_observations'],
      rejected: ['signed', 'submitted', 'rejected'],
      cancelled: ['signed', 'submitted', 'approved', 'cancelled'],
    };
    for (const step of path[status] ?? []) {
      await handle.db.update(documents).set({ status: step }).where(eq(documents.id, id));
    }
  }

  const credit = (overrides: Partial<AcceptCreditNoteInput> = {}): AcceptCreditNoteInput => {
    const draft = { associatedCdc: feCdc, reasonCode: 2, items: [ITEM], roundingPyg: 0 };
    return {
      tenantId,
      actor: { type: 'api_key', id: 'key-1' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: { type: 'NCE', ...draft },
      idempotencyKey: `nce-${String(++keySeq)}`,
      ...overrides,
    };
  };

  const rows = () =>
    withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents));
  const rulesOf = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvoiceValidationError);
    return (error as InvoiceValidationError).errors.map((e) => e.rule);
  };

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
    await seedIssuer(handle.db, tenantId);
    await seedIssuer(handle.db, otherTenantId);
    const fe = await acceptedInvoice(tenantId);
    feCdc = fe.cdc;
    feId = fe.documentId;
  });

  afterEach(async () => {
    await handle.close();
  });

  it('stores an NCE with type 05, its own numbering, the association and the FE receiver', async () => {
    const { documentId, cdc } = await acceptCredit()(credit());

    expect(parseCdc(cdc)).toMatchObject({ documentType: '05', documentNumber: '0000001' });
    const row = (await rows()).find((r) => r.id === documentId);
    expect(row).toMatchObject({
      documentType: 5,
      number: 1,
      status: 'accepted',
      associatedCdc: feCdc,
      receiverRuc: '80069563-1',
      currency: 'PYG',
    });
    expect(row?.totalAmount).toBe('400000.00000000');
    const audit = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, documentId)),
    );
    expect(audit[0]).toMatchObject({ action: 'document.accepted' });
  });

  it('leaves the FE untouched: no association and its own sequence', async () => {
    await acceptCredit()(credit());
    const fe = (await rows()).find((r) => r.id === feId);
    expect(fe).toMatchObject({ documentType: 1, number: 1, associatedCdc: null });
  });

  it.each(['approved', 'approved_with_observations'])('credits an FE %s', async (status) => {
    const other = await acceptedInvoice(tenantId, status);
    const draft = { associatedCdc: other.cdc, reasonCode: 1, items: [ITEM], roundingPyg: 0 };
    await expect(
      acceptCredit()(credit({ draft, payload: { type: 'NCE', ...draft } })),
    ).resolves.toMatchObject({ cdc: expect.stringMatching(/^05/) as string });
  });

  describe('refusals burn no number', () => {
    const nextNumberIsOne = async () => {
      const { cdc } = await acceptCredit()(credit());
      expect(parseCdc(cdc).documentNumber).toBe('0000001');
    };

    it('rejects an unknown FE (2403)', async () => {
      const draft = {
        associatedCdc: `01${'1'.repeat(42)}`,
        reasonCode: 2,
        items: [ITEM],
        roundingPyg: 0,
      };
      expect(await rulesOf(acceptCredit()(credit({ draft })))).toEqual([
        'associated-document-not-found',
      ]);
      await nextNumberIsOne();
    });

    it("rejects another tenant's FE as not found, never leaking it", async () => {
      const foreign = await acceptedInvoice(otherTenantId);
      const draft = { associatedCdc: foreign.cdc, reasonCode: 2, items: [ITEM], roundingPyg: 0 };
      expect(await rulesOf(acceptCredit()(credit({ draft })))).toEqual([
        'associated-document-not-found',
      ]);
      await nextNumberIsOne();
    });

    it('rejects an FE that SIFEN has not approved', async () => {
      const pending = await acceptedInvoice(tenantId, 'signed');
      const draft = { associatedCdc: pending.cdc, reasonCode: 2, items: [ITEM], roundingPyg: 0 };
      expect(await rulesOf(acceptCredit()(credit({ draft })))).toEqual([
        'associated-document-not-approved',
      ]);
      await nextNumberIsOne();
    });

    it('rejects a cancelled FE (2404)', async () => {
      const gone = await acceptedInvoice(tenantId, 'cancelled');
      const draft = { associatedCdc: gone.cdc, reasonCode: 2, items: [ITEM], roundingPyg: 0 };
      expect(await rulesOf(acceptCredit()(credit({ draft })))).toEqual([
        'associated-document-cancelled',
      ]);
      await nextNumberIsOne();
    });

    it('rejects a credit over the FE total with 2417 and keeps the numbering gapless', async () => {
      const big = { ...ITEM, unitPrice: 1_000_050 };
      const draft = { associatedCdc: feCdc, reasonCode: 2, items: [big], roundingPyg: 0 };
      expect(await rulesOf(acceptCredit()(credit({ draft })))).toEqual([
        'credit-note-sum-exceeds-invoice',
      ]);
      await nextNumberIsOne();
    });
  });

  it('answers a domain error, not a 500, when the FE payload cannot be read any more', async () => {
    const [fe] = await handle.db.select().from(documents).where(eq(documents.id, feId));
    const [broken] = await handle.db
      .insert(documents)
      .values({
        ...fe,
        id: undefined,
        cdc: `01${'2'.repeat(42)}`,
        number: 2,
        idempotencyKey: 'fe-broken',
        payload: { legacy: true },
        status: 'approved',
      })
      .returning();
    const draft = { associatedCdc: broken.cdc, reasonCode: 2, items: [ITEM], roundingPyg: 0 };
    expect(await rulesOf(acceptCredit()(credit({ draft })))).toEqual([
      'associated-document-unreadable',
    ]);
  });

  describe('sum of credits (2417)', () => {
    const creditOf = (unitPrice: number) => {
      const draft = {
        associatedCdc: feCdc,
        reasonCode: 2,
        items: [{ ...ITEM, unitPrice }],
        roundingPyg: 0,
      };
      return credit({ draft, payload: { type: 'NCE', ...draft } });
    };

    it('refuses what exceeds the rest after earlier credits and accepts what completes it', async () => {
      await acceptCredit()(creditOf(700_000));
      expect(await rulesOf(acceptCredit()(creditOf(400_000)))).toEqual([
        'credit-note-sum-exceeds-invoice',
      ]);
      await expect(acceptCredit()(creditOf(300_000))).resolves.toBeDefined();
    });

    it('counts a rejected NCE (it is resent with the same CDC)', async () => {
      const first = await acceptCredit()(creditOf(700_000));
      await advance(first.documentId, 'rejected');
      expect(await rulesOf(acceptCredit()(creditOf(400_000)))).toEqual([
        'credit-note-sum-exceeds-invoice',
      ]);
    });

    it('releases the credit of a cancelled or number-voided NCE', async () => {
      const first = await acceptCredit()(creditOf(700_000));
      await advance(first.documentId, 'cancelled');
      await expect(acceptCredit()(creditOf(400_000))).resolves.toBeDefined();
      const second = (await rows()).find((r) => r.number === 2 && r.documentType === 5);
      await handle.db
        .update(documents)
        .set({ status: 'signed' })
        .where(eq(documents.id, second?.id ?? ''));
      await handle.db
        .update(documents)
        .set({ status: 'number_voided' })
        .where(eq(documents.id, second?.id ?? ''));
      await expect(acceptCredit()(creditOf(900_000))).resolves.toBeDefined();
    });

    it('never lets two concurrent NCEs exceed the FE total', async () => {
      const results = await Promise.allSettled([
        acceptCredit()(creditOf(600_000)),
        acceptCredit()(creditOf(600_000)),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const credits = (await rows()).filter((r) => r.documentType === 5);
      expect(credits).toHaveLength(1);
      expect(credits[0]?.number).toBe(1);
    });
  });

  describe('idempotency', () => {
    it('replays the same key and body without a second document', async () => {
      const input = credit({ idempotencyKey: 'nce-fixed' });
      const first = await acceptCredit()(input);
      const second = await acceptCredit()(input);
      expect(second).toEqual(first);
      expect((await rows()).filter((r) => r.documentType === 5)).toHaveLength(1);
    });

    it('answers 409-style reuse for the same key with another body', async () => {
      await acceptCredit()(credit({ idempotencyKey: 'nce-fixed' }));
      const other = { associatedCdc: feCdc, reasonCode: 3, items: [ITEM], roundingPyg: 0 };
      await expect(
        acceptCredit()(
          credit({
            idempotencyKey: 'nce-fixed',
            draft: other,
            payload: { type: 'NCE', ...other },
          }),
        ),
      ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    });
  });

  it('refuses a draft with an invalid reason or items before touching the database', async () => {
    const draft = { associatedCdc: feCdc, reasonCode: 9, items: [], roundingPyg: 0 };
    expect((await rulesOf(acceptCredit()(credit({ draft })))).sort()).toEqual([
      'credit-note-reason',
      'items-required',
    ]);
  });
});
