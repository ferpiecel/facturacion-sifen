/** Lifecycle events a webhook endpoint can subscribe to (plan v1.1 §19, ADR-0011). */
export const WEBHOOK_EVENT_TYPES = [
  'document.approved',
  'document.approved_with_observations',
  'document.rejected',
  'document.cancelled',
  'document.number_voided',
  'document.transmission_deadline_warning',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Envelope delivered to integrators; `data` is event-specific and already free of secrets. */
export interface WebhookEvent {
  readonly id: string;
  readonly type: WebhookEventType;
  /** UTC, ISO 8601. */
  readonly created_at: string;
  readonly tenant_id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export class InvalidWebhookEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWebhookEventError';
  }
}

const EVENT_ID = /^evt_[A-Za-z0-9]{8,64}$/;

export interface WebhookEventInput {
  readonly id: string;
  readonly type: string;
  readonly createdAt: Date;
  readonly tenantId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** @throws InvalidWebhookEventError when the id, type, tenant or timestamp is malformed. */
export function createWebhookEvent(input: WebhookEventInput): WebhookEvent {
  if (!EVENT_ID.test(input.id)) {
    throw new InvalidWebhookEventError('event id must look like evt_<8-64 alphanumerics>');
  }
  if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(input.type)) {
    throw new InvalidWebhookEventError(`unknown event type ${input.type}`);
  }
  if (input.tenantId === '') {
    throw new InvalidWebhookEventError('tenant id is required');
  }
  if (Number.isNaN(input.createdAt.getTime())) {
    throw new InvalidWebhookEventError('createdAt must be a valid date');
  }
  return {
    id: input.id,
    type: input.type as WebhookEventType,
    created_at: input.createdAt.toISOString(),
    tenant_id: input.tenantId,
    data: input.data,
  };
}

/** The exact bytes sent and signed; sign and send this same string, never a re-serialization. */
export function serializeWebhookEvent(event: WebhookEvent): string {
  return JSON.stringify(event);
}

/** An empty filter subscribes the endpoint to every event. */
export function matchesEventFilter(filter: readonly string[], type: WebhookEventType): boolean {
  return filter.length === 0 || filter.includes(type);
}
