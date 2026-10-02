/**
 * Lifecycle events a webhook endpoint can subscribe to. Plan v1.0 §13 lists created, signed,
 * submitted, approved, rejected, cancelled and the notification pair; plan v1.1 §19 adds
 * `approved_with_observations` (renaming v1.0's `approved_with_warnings`), `number_voided` and
 * `transmission_deadline_warning` rather than replacing the list. `lote.*` and `event.*` of
 * v1.0 are not document lifecycle events and are out of this story.
 */
export const WEBHOOK_EVENT_TYPES = [
  'document.created',
  'document.signed',
  'document.submitted',
  'document.approved',
  'document.approved_with_observations',
  'document.rejected',
  'document.cancelled',
  'document.number_voided',
  'document.transmission_deadline_warning',
  'document.notification.delivered',
  'document.notification.failed',
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
  assertJsonSafe(input.data, 0);
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

const MAX_DATA_DEPTH = 32;

/** `data` must survive `JSON.stringify` unchanged: plain objects, arrays, strings, finite numbers, booleans, null. */
function assertJsonSafe(value: unknown, depth: number, seen: Set<object> = new Set()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidWebhookEventError('data must not hold NaN or Infinity');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new InvalidWebhookEventError(`data must not hold a ${typeof value}`);
  }
  if (depth >= MAX_DATA_DEPTH || seen.has(value)) {
    throw new InvalidWebhookEventError('data is circular or too deep');
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new InvalidWebhookEventError('data must hold plain objects only');
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    assertJsonSafe(child, depth + 1, seen);
  }
  seen.delete(value);
}
