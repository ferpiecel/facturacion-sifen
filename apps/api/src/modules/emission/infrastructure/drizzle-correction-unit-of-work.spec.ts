import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documentCorrectionClaims,
  documentCorrections,
  documents,
  issuerEvents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import {
  acceptInvoiceWithStatus,
  FE_BODY,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import {
  DocumentNotCorrectableError,
  createCorrectDocument,
  type CorrectDocumentInput,
} from '../application/correct-document.js';
import { createAcceptInvoice } from '../application/accept-invoice.js';
import { createVoidNumbers } from '../../issuer-events/application/void-numbers.js';
import { createDrizzleVoidingUnitOfWork } from '../../issuer-events/infrastructure/drizzle-voiding-unit-of-work.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';
import { parseCreateDocument, toInvoiceDraft } from './http/create-document.request.js';
import { createDrizzleCorrectionUnitOfWork } from './drizzle-correction-unit-of-work.js';

const now = () => new Date('2026-03-06T01:30:00Z');

/** Spec: HU-E8-01 (ADR-0021). The same-CDC correction against a real (pglite) database. */
describe('CorrectDocument with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let documentId: string;
  let cdc: string;

  const corrected = { ...FE_BODY, items: [{ ...FE_BODY.items[0], unitPrice: 500_000 }] };
  const input = (key = 'fix-1'): CorrectDocumentInput => {
    const parsed = parseCreateDocument(corrected);
    if (!parsed.ok) throw new Error('invalid fixture');
    return {
      tenantId,
      actor: { type: 'api_key', id: 'k' },
      documentId,
      establishmentCode: '001',
      expeditionPointCode: '002',
      correction: { type: 'FE', draft: toInvoiceDraft(parsed.value), receiverRuc: '80069563-1' },
      payload: parsed.value,
      idempotencyKey: key,
    };
  };
  const correct = (at = now) => {
    const acceptance = {
      unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
      now: at,
    };
    return createCorrectDocument({
      unitOfWork: createDrizzleCorrectionUnitOfWork(handle.db),
      accept: {
        FE: createAcceptInvoice(acceptance),
        AFE: () => Promise.reject(new Error('unused')),
        NCE: () => Promise.reject(new Error('unused')),
        NDE: () => Promise.reject(new Error('unused')),
      },
      voidNumbers: createVoidNumbers({ unitOfWork: createDrizzleVoidingUnitOfWork(handle.db) }),
      now: at,
    });
  };
  const row = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.id, documentId)),
    ).then((rows) => rows[0]);

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }])
      .returning();
    tenantId = a.id;
    await seedIssuer(handle.db, tenantId);
    ({ documentId, cdc } = await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-1', 'rejected'));
    await handle.db
      .update(documents)
      .set({ sifenMessages: [{ code: '1000', message: 'x' }] })
      .where(eq(documents.id, documentId));
  });

  afterEach(async () => {
    await handle.close();
  });

  it('rewrites the rejected row for a new send and keeps the previous body in the history', async () => {
    await expect(correct()(input())).resolves.toEqual({ documentId, cdc });

    expect(await row()).toMatchObject({
      status: 'accepted',
      cdc,
      correctionsCount: 1,
      totalAmount: '500000.00000000',
      signedXml: null,
      sifenMessages: null,
      transmissionAttempts: 0,
    });
    const [history] = await handle.db.select().from(documentCorrections);
    expect(history).toMatchObject({
      documentId,
      kind: 'same_cdc',
      idempotencyKey: 'fix-1',
      previousSifenMessages: [{ code: '1000', message: 'x' }],
    });
  });

  it('moves updated_at when it rewrites the row', async () => {
    const before = (await row()).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await correct()(input());
    expect((await row()).updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('replays the same key without a second correction', async () => {
    await correct()(input());
    await expect(correct()(input())).resolves.toEqual({ documentId, cdc });
    expect((await row()).correctionsCount).toBe(1);
  });

  it('refuses a second correction once the document is no longer rejected', async () => {
    await correct()(input());
    await expect(correct()(input('fix-2'))).rejects.toEqual(
      new DocumentNotCorrectableError('accepted'),
    );
  });

  it('reissues past the 72 h window: a new document, the history link and the old number voided', async () => {
    const later = () => new Date('2026-03-20T12:00:00Z');
    const result = await correct(later)(input('fix-late'));

    expect(result.documentId).not.toBe(documentId);
    expect(result.cdc).not.toBe(cdc);
    expect((await row()).status).toBe('rejected');
    const [history] = await handle.db.select().from(documentCorrections);
    expect(history).toMatchObject({
      documentId,
      kind: 'reissue',
      replacementDocumentId: result.documentId,
    });
    const events = await handle.db.select().from(issuerEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'voiding', status: 'pending' });
    await expect(correct(later)(input('fix-late'))).resolves.toEqual(result);
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(1);
    await expect(correct(later)(input('fix-other'))).rejects.toEqual(
      new DocumentNotCorrectableError('reissued'),
    );
  });
  it('refuses a rewrite while a reissue holds the claim, leaving the row rejected', async () => {
    await handle.db.insert(documentCorrectionClaims).values({
      tenantId,
      documentId,
      idempotencyKey: 'reissue-key',
      requestHash: 'a'.repeat(64),
    });
    await expect(correct()(input())).rejects.toEqual(
      new DocumentNotCorrectableError('correction_in_progress'),
    );
    expect((await row()).status).toBe('rejected');
    expect(await handle.db.select().from(documentCorrections)).toHaveLength(0);
  });

  it('claims the document for a reissue and takes no claim for a refused body', async () => {
    const later = () => new Date('2026-03-20T12:00:00Z');
    const base = input('fix-bad');
    const invalid = {
      ...base,
      correction: { ...base.correction, draft: { ...base.correction.draft, items: [] } },
    };
    await expect(correct(later)(invalid as CorrectDocumentInput)).rejects.toBeInstanceOf(Error);
    expect(await handle.db.select().from(documentCorrectionClaims)).toHaveLength(0);
    await expect(correct(later)(input('fix-late'))).resolves.toMatchObject({});
    // The linked reissue keeps its claim: the document is final.
    expect(await handle.db.select().from(documentCorrectionClaims)).toHaveLength(1);
  });
});
