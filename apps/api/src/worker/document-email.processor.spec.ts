import {
  createPgliteDatabase,
  documentEmails,
  InvalidTenantIdError,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDocuments } from '../../test/support/document-seed.js';
import { MailerError } from '../modules/email/application/ports/document-mailer.port.js';
import {
  DOCUMENT_EMAIL_QUEUE,
  createDocumentEmailProcessor,
  documentEmailJob,
} from './document-email.processor.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');

/** Spec: HU-E11-02 (S4 wiring). Outbox rows are sent, with attachments, by the per-tenant job processor. */
describe('document email worker', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let emailId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    [{ id: tenantId }] = await handle.db.insert(tenants).values({ name: 'Acme SA' }).returning();
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved'], () => ({
      signedXml: '<DE/>',
      signedAt: NOW,
    }));
    [{ id: emailId }] = await handle.db
      .insert(documentEmails)
      .values({
        tenantId,
        documentId: doc.id,
        recipient: 'cliente@example.com',
        nextAttemptAt: NOW,
      })
      .returning();
  });
  afterEach(async () => {
    await handle.close();
  });

  const processor = (send: () => Promise<void>) =>
    createDocumentEmailProcessor({
      db: handle.db,
      mailer: { send: vi.fn(send) },
      getKude: () =>
        Promise.resolve({ kind: 'ok', pdf: new Uint8Array([1]), filename: 'kude.pdf' }),
      reader: {
        findSignedXml: () =>
          Promise.resolve({ number: '001-001-0000001', environment: 'test', signedXml: '<DE/>' }),
      },
      now: () => NOW,
    });
  const row = async () => (await handle.db.select().from(documentEmails))[0];

  it('names one repeatable job per tenant on the document-email queue', () => {
    const job = documentEmailJob(tenantId);
    expect(DOCUMENT_EMAIL_QUEUE).toBe('document-email');
    expect(job.opts.jobId).toBe(`document-email:${tenantId}`);
    expect(job.data).toEqual({ tenantId });
  });

  it('sends the due email and marks it sent', async () => {
    const summary = await processor(() => Promise.resolve())({ data: { tenantId } });
    expect(summary).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row()).toMatchObject({ id: emailId, status: 'sent', attemptCount: 1 });
  });

  it('marks a permanent failure dead without retry', async () => {
    await processor(() => Promise.reject(new MailerError(false, 'smtp_rejected')))({
      data: { tenantId },
    });
    expect(await row()).toMatchObject({ status: 'dead', lastError: 'smtp_rejected' });
  });

  it('rejects a malformed tenant id before building any query', async () => {
    await expect(
      processor(() => Promise.resolve())({ data: { tenantId: "x'; drop table" } }),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
  });
});
