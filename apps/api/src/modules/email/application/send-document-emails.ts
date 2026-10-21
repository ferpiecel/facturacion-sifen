import type { KudeResult } from '../../emission/application/get-kude.js';
import { KudeSourceError } from '../../emission/application/kude-reader.js';
import type { SignedXmlReader } from '../../emission/application/ports/signed-xml-reader.port.js';
import { MAX_EMAIL_ATTEMPTS, nextEmailAttemptAt } from '../domain/email-backoff.js';
import type {
  DocumentEmailStore,
  DueDocumentEmail,
  EmailAttemptOutcome,
} from './ports/document-email-store.port.js';
import {
  MailerError,
  type DocumentEmail,
  type DocumentMailer,
} from './ports/document-mailer.port.js';

/** A claim holds an email this long; a crash before `record` makes it due again afterwards. */
const LEASE_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 10;

export interface SendDocumentEmailsDeps {
  readonly store: DocumentEmailStore;
  readonly mailer: DocumentMailer;
  readonly getKude: (tenantId: string, documentId: string) => Promise<KudeResult>;
  readonly reader: SignedXmlReader;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

export interface SendSummary {
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
  /** Attempts made whose result could not be stored; the lease makes them due again. */
  readonly unrecorded: number;
}

/** Why an attempt failed before or while sending: `transient` decides retry or dead. */
class AttemptFailure extends Error {
  constructor(
    readonly transient: boolean,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Sends the due approved-document emails of one tenant (HU-E11-02): the KuDE letter and the signed XML
 * as attachments. A permanent failure (the mailer refuses the message, the KuDE cannot be produced)
 * is dead at once; a transient one is retried with a backoff until the attempts run out. Only a
 * classified code is stored, never provider text, addresses or XML.
 */
export function createSendDocumentEmails(deps: SendDocumentEmailsDeps) {
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  async function build(row: DueDocumentEmail): Promise<DocumentEmail> {
    let kude: KudeResult;
    try {
      kude = await deps.getKude(row.tenantId, row.documentId);
    } catch (error) {
      throw error instanceof KudeSourceError
        ? new AttemptFailure(false, 'kude_unavailable')
        : new AttemptFailure(true, 'attachment_failed');
    }
    if (kude.kind !== 'ok') throw new AttemptFailure(false, 'kude_unavailable');
    const found = await deps.reader.findSignedXml(row.tenantId, row.documentId).catch(() => {
      throw new AttemptFailure(true, 'attachment_failed');
    });
    if (found?.signedXml == null) throw new AttemptFailure(false, 'kude_unavailable');
    return {
      messageId: `${row.id}@sifen`,
      to: row.recipient,
      fromName: row.tenantName,
      subject: `Documento electrónico ${found.number} de ${row.tenantName}`,
      text: `Adjuntamos el documento electrónico ${found.number} emitido por ${row.tenantName}: su representación gráfica (KuDE, PDF) y el archivo XML firmado.`,
      attachments: [
        { filename: kude.filename, contentType: 'application/pdf', content: kude.pdf },
        {
          filename: `${found.number}.xml`,
          contentType: 'application/xml',
          content: found.signedXml,
        },
      ],
    };
  }

  async function attempt(row: DueDocumentEmail): Promise<EmailAttemptOutcome | undefined> {
    const at = now();
    const attemptCount = row.attemptCount; // the claim already counted this attempt
    let failure: AttemptFailure | undefined;
    try {
      await deps.mailer.send(await build(row));
    } catch (error) {
      failure =
        error instanceof AttemptFailure
          ? error
          : error instanceof MailerError
            ? new AttemptFailure(error.transient, error.message)
            : new AttemptFailure(true, 'send_failed');
    }
    const next =
      failure?.transient && attemptCount < MAX_EMAIL_ATTEMPTS
        ? nextEmailAttemptAt(attemptCount, at)
        : null;
    const outcome: EmailAttemptOutcome = {
      status: failure === undefined ? 'sent' : next === null ? 'dead' : 'failed',
      attemptCount,
      lastAttemptAt: at,
      nextAttemptAt: next,
      sentAt: failure === undefined ? at : null,
      lastError: failure === undefined ? null : failure.code.slice(0, 64),
    };
    try {
      await deps.store.record(row.id, outcome);
      return outcome;
    } catch {
      return undefined;
    }
  }

  return async (): Promise<SendSummary> => {
    const rows = await deps.store.claimDue(now(), batchSize, LEASE_MS);
    const outcomes: (EmailAttemptOutcome | undefined)[] = [];
    // Sequential: one SMTP account, and a large PDF render at a time keeps the worker's memory flat.
    for (const row of rows) outcomes.push(await attempt(row));
    const count = (status: EmailAttemptOutcome['status']) =>
      outcomes.filter((o) => o?.status === status).length;
    return {
      claimed: rows.length,
      sent: count('sent'),
      retried: count('failed'),
      dead: count('dead'),
      unrecorded: outcomes.filter((o) => o === undefined).length,
    };
  };
}
