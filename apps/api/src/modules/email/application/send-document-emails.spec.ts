import { describe, expect, it, vi } from 'vitest';
import { KudeSourceError } from '../../emission/application/kude-reader.js';
import type { KudeResult } from '../../emission/application/get-kude.js';
import { MAX_EMAIL_ATTEMPTS } from '../domain/email-backoff.js';
import { MailerError, type DocumentMailer } from './ports/document-mailer.port.js';
import type {
  DocumentEmailStore,
  DueDocumentEmail,
  EmailAttemptOutcome,
} from './ports/document-email-store.port.js';
import { createSendDocumentEmails } from './send-document-emails.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const due = (over: Partial<DueDocumentEmail> = {}): DueDocumentEmail => ({
  id: 'e1',
  tenantId: 't1',
  documentId: 'd1',
  recipient: 'cliente@example.com',
  attemptCount: 1,
  tenantName: 'Acme SA',
  ...over,
});

function setup(
  rows: DueDocumentEmail[],
  opts: {
    send?: DocumentMailer['send'];
    kude?: () => Promise<KudeResult>;
    xml?: string | null;
    recordFails?: boolean;
    logger?: { warn(message: string): void };
  } = {},
) {
  const outcomes: Record<string, EmailAttemptOutcome> = {};
  const store: DocumentEmailStore = {
    claimDue: vi.fn(() => Promise.resolve(rows)),
    record: vi.fn((id: string, o: EmailAttemptOutcome) => {
      if (opts.recordFails) return Promise.reject(new Error('db down'));
      outcomes[id] = o;
      return Promise.resolve();
    }),
  };
  const send = vi.fn<DocumentMailer['send']>(opts.send ?? (() => Promise.resolve()));
  const run = createSendDocumentEmails({
    store,
    mailer: { send },
    getKude:
      opts.kude ??
      (() => Promise.resolve({ kind: 'ok', pdf: new Uint8Array([1]), filename: 'kude-001.pdf' })),
    reader: {
      findSignedXml: () =>
        Promise.resolve({
          number: '001-002-0000007',
          environment: 'test',
          signedXml: opts.xml === undefined ? '<DE/>' : opts.xml,
        }),
    },
    now: () => NOW,
    logger: opts.logger,
  });
  return { run, send, outcomes, store };
}

describe('sendDocumentEmails', () => {
  it('sends the KuDE and the signed XML and records sent', async () => {
    const { run, send, outcomes } = setup([due()]);
    expect(await run()).toEqual({ claimed: 1, sent: 1, retried: 0, dead: 0, unrecorded: 0 });
    const email = send.mock.calls[0][0];
    expect(email).toMatchObject({
      to: 'cliente@example.com',
      fromName: 'Acme SA',
      messageId: 'e1@sifen',
    });
    expect(email.attachments.map((a) => a.filename)).toEqual([
      'kude-001.pdf',
      '001-002-0000007.xml',
    ]);
    expect(outcomes.e1).toMatchObject({
      status: 'sent',
      attemptCount: 1,
      sentAt: NOW,
      lastError: null,
    });
  });

  it('retries a transient failure with a backoff and records only the code', async () => {
    const { run, outcomes } = setup([due()], {
      send: () => Promise.reject(new MailerError(true, 'smtp_timeout')),
    });
    expect((await run()).retried).toBe(1);
    expect(outcomes.e1).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastError: 'smtp_timeout',
    });
    expect(outcomes.e1.nextAttemptAt?.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('kills a permanent failure without retrying', async () => {
    const { run, outcomes } = setup([due()], {
      send: () => Promise.reject(new MailerError(false, 'smtp_rejected')),
    });
    expect((await run()).dead).toBe(1);
    expect(outcomes.e1).toMatchObject({
      status: 'dead',
      nextAttemptAt: null,
      lastError: 'smtp_rejected',
    });
  });

  it('kills a transient failure once the attempts are used up', async () => {
    const { run, outcomes } = setup([due({ attemptCount: MAX_EMAIL_ATTEMPTS })], {
      send: () => Promise.reject(new MailerError(true, 'smtp_timeout')),
    });
    await run();
    expect(outcomes.e1.status).toBe('dead');
  });

  it('kills an email whose KuDE can never be rendered, without sending', async () => {
    const { run, send, outcomes } = setup([due()], {
      kude: () => Promise.reject(new KudeSourceError('dCarQR', 'x')),
    });
    await run();
    expect(send).not.toHaveBeenCalled();
    expect(outcomes.e1).toMatchObject({ status: 'dead', lastError: 'kude_unavailable' });
  });

  it('retries an unexpected failure as transient', async () => {
    const { run, outcomes } = setup([due()], { kude: () => Promise.reject(new Error('boom')) });
    await run();
    expect(outcomes.e1).toMatchObject({ status: 'failed', lastError: 'attachment_failed' });
  });

  it('kills an email whose document has no signed XML', async () => {
    const { run, outcomes } = setup([due()], {
      kude: () => Promise.resolve({ kind: 'not-signed' }),
    });
    await run();
    expect(outcomes.e1).toMatchObject({ status: 'dead', lastError: 'kude_unavailable' });
  });

  it('leases a batch for its worst case: every row with the full SMTP timeouts', async () => {
    const { run, store } = setup([due()]);
    await run();
    const [, limit, leaseMs] = (store.claimDue as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Date,
      number,
      number,
    ];
    // Three 30 s SMTP timeouts per send, plus the KuDE render, for each row of the batch.
    expect(leaseMs).toBeGreaterThanOrEqual(limit * 3 * 30_000);
  });

  it('logs an unrecorded outcome with ids only', async () => {
    const warn = vi.fn();
    const { run } = setup([due({ id: 'e9' })], { recordFails: true, logger: { warn } });
    await run();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('e9');
    expect(message).not.toContain('db down');
    expect(message).not.toContain('cliente@example.com');
  });

  it('counts an outcome that could not be stored as unrecorded', async () => {
    const { run } = setup([due()], { recordFails: true });
    expect((await run()).unrecorded).toBe(1);
  });
});
