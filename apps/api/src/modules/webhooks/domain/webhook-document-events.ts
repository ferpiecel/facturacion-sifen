import { createHash } from 'node:crypto';
import type { WebhookEventType } from './webhook-event.js';

const STATUS_EVENTS: Readonly<Record<string, WebhookEventType>> = {
  accepted: 'document.created',
  signed: 'document.signed',
  submitted: 'document.submitted',
  approved: 'document.approved',
  approved_with_observations: 'document.approved_with_observations',
  rejected: 'document.rejected',
  cancelled: 'document.cancelled',
  number_voided: 'document.number_voided',
};

/** The webhook event a document entering `status` produces; `queued` and `corrected` produce none. */
export function eventTypeForDocumentStatus(status: string): WebhookEventType | undefined {
  return Object.hasOwn(STATUS_EVENTS, status) ? STATUS_EVENTS[status] : undefined;
}

/**
 * Deterministic: a document reaches each status once, so one event per (document, type). The outbox
 * relies on it (with UNIQUE(endpoint_id, event_id)) so a retried transition never enqueues twice.
 */
export function documentEventId(documentId: string, type: WebhookEventType): string {
  return `evt_${createHash('sha256').update(`${documentId}:${type}`).digest('hex').slice(0, 32)}`;
}

export interface DocumentEventSource {
  readonly id: string;
  readonly cdc: string;
  readonly documentType: number;
  readonly status: string;
  /** SIFEN's `[{code, message}]` of the final result, as stored (untrusted shape). */
  readonly sifenMessages: unknown;
}

const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 500;

function sanitizeMessages(value: unknown): { code: string; message: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { code: string; message: string }[] = [];
  for (const item of value as unknown[]) {
    const { code, message } = (item ?? {}) as Record<string, unknown>;
    if (typeof code === 'string' && typeof message === 'string') {
      out.push({ code, message: message.slice(0, MAX_MESSAGE_LENGTH) });
    }
    if (out.length === MAX_MESSAGES) break;
  }
  return out;
}

/** Minimal event data: identifiers, status and SIFEN's messages. No XML, receiver or amounts. */
export function documentEventData(source: DocumentEventSource): Record<string, unknown> {
  const messages = sanitizeMessages(source.sifenMessages);
  return {
    document_id: source.id,
    cdc: source.cdc,
    document_type: source.documentType,
    status: source.status,
    ...(messages.length > 0 ? { sifen_messages: messages } : {}),
  };
}
