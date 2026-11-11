import { createTransport } from 'nodemailer';
import {
  MailerError,
  type DocumentEmail,
  type DocumentMailer,
} from '../../application/ports/document-mailer.port.js';
import { isPlainEmailAddress } from '../../domain/plain-email-address.js';
import type { EmailConfig } from '../email-config.js';

/** The slice of a nodemailer transport the adapter uses; tests inject their own. */
export interface MailTransport {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

type EnabledConfig = Extract<EmailConfig, { enabled: true }>;

const SMTP_TIMEOUT_MS = 30_000;

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** SMTP 5xx is a verdict on the address or message; everything else (network, 4xx) may heal. */
function toMailerError(error: unknown): MailerError {
  const { code, responseCode } = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const permanent = typeof responseCode === 'number' && responseCode >= 500;
  const label = typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? code : 'UNKNOWN';
  const status = typeof responseCode === 'number' ? ` (${String(responseCode)})` : '';
  return new MailerError(!permanent, `SMTP send failed: ${label}${status}`);
}

/** {@link DocumentMailer} over the platform's SMTP account (nodemailer). */
export function createSmtpDocumentMailer(
  config: EnabledConfig,
  options: { transport?: MailTransport } = {},
): DocumentMailer {
  const transport: MailTransport =
    options.transport ??
    createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure && !config.allowPlaintext,
      ignoreTLS: config.allowPlaintext && !config.secure,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      ...(config.user === undefined ? {} : { auth: { user: config.user, pass: config.password } }),
    });
  return {
    send: async (email: DocumentEmail) => {
      // One mailbox per field, validated here: a list in `to` would leak the invoice to others.
      if (
        !isPlainEmailAddress(email.to) ||
        (email.replyTo !== undefined && !isPlainEmailAddress(email.replyTo))
      ) {
        throw new MailerError(false, 'SMTP send refused: INVALID_ADDRESS');
      }
      try {
        await transport.sendMail({
          messageId: `<${email.messageId}>`,
          from: { name: oneLine(email.fromName), address: config.fromAddress },
          to: { address: email.to },
          ...(email.replyTo === undefined ? {} : { replyTo: { address: email.replyTo } }),
          subject: oneLine(email.subject),
          text: email.text,
          attachments: email.attachments.map((a) => ({
            filename: oneLine(a.filename),
            contentType: a.contentType,
            content: typeof a.content === 'string' ? a.content : Buffer.from(a.content),
          })),
        });
      } catch (error) {
        throw toMailerError(error);
      }
    },
  };
}
