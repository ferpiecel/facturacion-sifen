export interface EmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array | string;
}

/** One message to one receiver (HU-E11-02). */
export interface DocumentEmail {
  /**
   * Stable per outbox row, without angle brackets. It becomes the `Message-ID`, so a retry after an
   * ambiguous failure carries the same id and the receiver's mail system can recognise the duplicate.
   */
  readonly messageId: string;
  readonly to: string;
  /** The tenant's name; the address is always the platform's (MVP: one SMTP account). */
  readonly fromName: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments: readonly EmailAttachment[];
}

/** Sends the approved document to its receiver. Rejects with {@link MailerError}. */
export interface DocumentMailer {
  send(email: DocumentEmail): Promise<void>;
}

/**
 * A failed send. `transient` tells the outbox whether a later attempt can succeed (connection, timeout,
 * 4xx) or not (5xx: the address or the message is refused). The message is a code, never provider text:
 * SMTP replies quote the receiver's address.
 */
export class MailerError extends Error {
  override name = 'MailerError';

  constructor(
    readonly transient: boolean,
    message: string,
  ) {
    super(message);
  }
}
