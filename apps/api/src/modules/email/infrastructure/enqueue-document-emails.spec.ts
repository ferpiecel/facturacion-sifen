import {
  createPgliteDatabase,
  documentEmails,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDocuments } from '../../../../test/support/document-seed.js';
import { enqueueDocumentEmails } from './enqueue-document-emails.js';

const AT = new Date('2026-10-01T12:00:00.000Z');
const xmlFor = (email?: string) =>
  `<rDE><DE Id="1"><gDatRec><dNomRec>X</dNomRec>${
    email === undefined ? '' : `<dEmailRec>${email}</dEmailRec>`
  }</gDatRec></DE></rDE>`;

/** Spec: HU-E11-02 (S3). One outbox row per approved document, in the caller's transaction. */
describe('enqueueDocumentEmails', () => {
  let handle: DatabaseHandle;
  let tenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    [{ id: tenantId }] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
  });
  afterEach(async () => {
    await handle.close();
  });

  const enqueue = (documentIds: string[]) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      enqueueDocumentEmails(tx, { tenantId, documentIds, at: AT }),
    );
  const rows = () => handle.db.select().from(documentEmails);
  const seed = (statuses: string[], xml: string | null = xmlFor('cliente@example.com')) =>
    seedDocuments(handle.db, tenantId, statuses, () => ({
      signedXml: xml,
      signedAt: xml === null ? null : AT,
    }));

  it('queues a pending email due now for an approved document', async () => {
    const [doc] = await seed(['approved']);
    await enqueue([doc.id]);
    expect(await rows()).toMatchObject([
      {
        documentId: doc.id,
        recipient: 'cliente@example.com',
        status: 'pending',
        nextAttemptAt: AT,
      },
    ]);
  });

  it('also covers approved with observations and ignores other statuses', async () => {
    const docs = await seed(['approved_with_observations', 'rejected', 'signed', 'cancelled']);
    await enqueue(docs.map((d) => d.id));
    expect((await rows()).map((r) => r.documentId)).toEqual([docs[0].id]);
  });

  it('is idempotent', async () => {
    const [doc] = await seed(['approved']);
    await enqueue([doc.id]);
    await enqueue([doc.id]);
    expect(await rows()).toHaveLength(1);
  });

  it('records skipped when the receiver has no address (innominado)', async () => {
    const [doc] = await seed(['approved'], xmlFor());
    await enqueue([doc.id]);
    expect(await rows()).toMatchObject([
      { status: 'skipped', recipient: null, nextAttemptAt: null, lastError: 'no_receiver_email' },
    ]);
  });

  it.each(['a@b.com, c@d.com', 'Name &lt;a@b.com&gt;', 'sin-arroba'])(
    'records skipped for the unusable address %s',
    async (address) => {
      const [doc] = await seed(['approved'], xmlFor(address));
      await enqueue([doc.id]);
      expect(await rows()).toMatchObject([
        { status: 'skipped', lastError: 'invalid_receiver_email' },
      ]);
    },
  );

  it('does nothing for no ids and for an unsigned document', async () => {
    await enqueue([]);
    const [doc] = await seed(['approved'], null);
    await enqueue([doc.id]);
    expect(await rows()).toEqual([]);
  });
});
