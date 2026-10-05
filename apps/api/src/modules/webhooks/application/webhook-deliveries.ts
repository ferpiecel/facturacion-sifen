import type { InputError } from '../domain/webhook-endpoint-input.js';
import type {
  DeliveryQuery,
  DeliveryView,
  WebhookDeliveryAdminStore,
} from './ports/webhook-delivery-admin-store.port.js';
import type { Actor } from './ports/webhook-endpoint-store.port.js';
import { WebhookEndpointNotFoundError, WebhookValidationError } from './webhook-endpoints.js';

export { WebhookEndpointNotFoundError, WebhookValidationError };

export class WebhookDeliveryNotFoundError extends WebhookEndpointNotFoundError {
  constructor() {
    super();
    this.message = 'Webhook delivery not found';
  }
}

export class WebhookDeliveryNotDeadError extends Error {
  constructor() {
    super('Only a dead delivery can be replayed');
    this.name = 'WebhookDeliveryNotDeadError';
  }
}

export class WebhookEndpointInactiveError extends Error {
  constructor() {
    super('endpoint inactive');
    this.name = 'WebhookEndpointInactiveError';
  }
}

const STATUSES = ['pending', 'failed', 'delivered', 'dead'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (item: DeliveryView): string =>
  Buffer.from(JSON.stringify([item.createdAt.toISOString(), item.id])).toString('base64url');

function decodeCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  try {
    const [iso, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    const createdAt = new Date(String(iso));
    return typeof id === 'string' && UUID.test(id) && !Number.isNaN(createdAt.getTime())
      ? { createdAt, id }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface WebhookDeliveryServiceDeps {
  readonly store: WebhookDeliveryAdminStore;
  readonly now?: () => Date;
}

/** Delivery history (newest first, keyset-paged) and replay of dead deliveries (HU-E11-01 S5). */
export function createWebhookDeliveryService({
  store,
  now = () => new Date(),
}: WebhookDeliveryServiceDeps) {
  return {
    async list(
      tenantId: string,
      raw: Readonly<Record<string, unknown>>,
    ): Promise<{ items: DeliveryView[]; nextCursor: string | null }> {
      const errors: InputError[] = [];
      const invalid = (field: string, message: string) => errors.push({ field, message });
      const query: { -readonly [K in keyof DeliveryQuery]: DeliveryQuery[K] } = {
        limit: DEFAULT_LIMIT,
      };
      if (raw.endpoint_id !== undefined) {
        if (typeof raw.endpoint_id === 'string' && UUID.test(raw.endpoint_id)) {
          query.endpointId = raw.endpoint_id;
        } else invalid('endpoint_id', 'endpoint_id must be a UUID');
      }
      if (raw.status !== undefined) {
        if (typeof raw.status === 'string' && STATUSES.includes(raw.status))
          query.status = raw.status;
        else invalid('status', `status must be one of: ${STATUSES.join(', ')}`);
      }
      if (raw.limit !== undefined) {
        const limit = Number(raw.limit);
        if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT) query.limit = limit;
        else invalid('limit', `limit must be an integer from 1 to ${String(MAX_LIMIT)}`);
      }
      if (raw.cursor !== undefined) {
        const after = typeof raw.cursor === 'string' ? decodeCursor(raw.cursor) : undefined;
        if (after) query.after = after;
        else invalid('cursor', 'cursor is not valid');
      }
      if (errors.length > 0) throw new WebhookValidationError(errors);
      const rows = await store.list(tenantId, query);
      const items = rows.slice(0, query.limit);
      return {
        items,
        nextCursor: rows.length > query.limit ? encodeCursor(items[items.length - 1]) : null,
      };
    },

    async replay(tenantId: string, actor: Actor, id: string): Promise<DeliveryView> {
      if (!UUID.test(id)) throw new WebhookDeliveryNotFoundError();
      const result = await store.replay(tenantId, actor, id, now());
      if (result === null) throw new WebhookDeliveryNotFoundError();
      if (result === 'not-dead') throw new WebhookDeliveryNotDeadError();
      if (result === 'endpoint-inactive') throw new WebhookEndpointInactiveError();
      return result;
    },
  };
}
