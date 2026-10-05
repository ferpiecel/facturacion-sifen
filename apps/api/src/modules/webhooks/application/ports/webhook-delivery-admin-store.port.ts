import type { Actor } from './webhook-endpoint-store.port.js';

/** What the API shows of a delivery: no payload body, no response data beyond the code and a classified error. */
export interface DeliveryView {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
}

export interface DeliveryQuery {
  readonly endpointId?: string;
  readonly status?: string;
  readonly limit: number;
  /** Keyset position: the (createdAt, id) of the last item of the previous page. */
  readonly after?: { readonly createdAt: Date; readonly id: string };
}

export interface WebhookDeliveryAdminStore {
  /** Newest first; may return up to `limit + 1` items so the service can tell whether a next page exists. */
  list(tenantId: string, query: DeliveryQuery): Promise<DeliveryView[]>;
  /**
   * Dead to pending, due now; `not-dead` when it is in any other state, `endpoint-inactive` when its
   * endpoint is disabled (it would be claimed by nobody), null when unknown.
   */
  replay(
    tenantId: string,
    actor: Actor,
    id: string,
    at: Date,
  ): Promise<DeliveryView | 'not-dead' | 'endpoint-inactive' | null>;
}
