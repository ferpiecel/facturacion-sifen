import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { DeliveryView } from '../../application/ports/webhook-delivery-admin-store.port.js';
import type { EndpointView } from '../../application/ports/webhook-endpoint-store.port.js';
import {
  WebhookDeliveryNotDeadError,
  WebhookEndpointInactiveError,
  WebhookEndpointNotFoundError,
  WebhookValidationError,
} from '../../application/webhook-deliveries.js';
import { WebhookRotationConflictError } from '../../application/webhook-endpoints.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can never name a row of this tenant: 404, never a database error. */
export function parseId(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException();
  return id;
}

/** A JSON object body, else `{}` so the service reports every missing field. */
export const asObject = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};

const problem = (status: HttpStatus, message: string, extra: object = {}) =>
  new HttpException({ statusCode: status, message, ...extra }, status);

/** Maps the service errors to the API's `{ statusCode, message, errors? }` bodies; anything else stays a 500. */
export function toHttpException(error: unknown): unknown {
  if (error instanceof WebhookValidationError) {
    return problem(HttpStatus.UNPROCESSABLE_ENTITY, 'Validation failed', { errors: error.errors });
  }
  if (error instanceof WebhookEndpointNotFoundError) {
    return problem(HttpStatus.NOT_FOUND, error.message);
  }
  if (
    error instanceof WebhookRotationConflictError ||
    error instanceof WebhookDeliveryNotDeadError ||
    error instanceof WebhookEndpointInactiveError
  ) {
    return problem(HttpStatus.CONFLICT, error.message);
  }
  return error;
}

export const endpointJson = (e: EndpointView) => ({
  id: e.id,
  url: e.url,
  events: e.events,
  active: e.active,
  secret_version: e.secretVersion,
  previous_secret_expires_at: e.previousExpiresAt?.toISOString() ?? null,
  created_at: e.createdAt.toISOString(),
  updated_at: e.updatedAt.toISOString(),
});

/**
 * A blocked address and a DNS failure look the same from outside: telling them apart would let an
 * integrator probe which internal names resolve to private addresses.
 */
const publicError = (error: string | null): string | null =>
  error === 'blocked_address' || error === 'dns_failure' ? 'unreachable' : error;

export const deliveryJson = (d: DeliveryView) => ({
  id: d.id,
  endpoint_id: d.endpointId,
  event_id: d.eventId,
  event_type: d.eventType,
  status: d.status,
  attempt_count: d.attemptCount,
  last_status_code: d.lastStatusCode,
  last_error: publicError(d.lastError),
  next_attempt_at: d.nextAttemptAt?.toISOString() ?? null,
  delivered_at: d.deliveredAt?.toISOString() ?? null,
  created_at: d.createdAt.toISOString(),
});
