import { describe, expect, it } from 'vitest';
import type {
  DeliveryQuery,
  DeliveryView,
  WebhookDeliveryAdminStore,
} from './ports/webhook-delivery-admin-store.port.js';
import {
  WebhookDeliveryNotDeadError,
  WebhookEndpointNotFoundError,
  WebhookValidationError,
  createWebhookDeliveryService,
} from './webhook-deliveries.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = { type: 'api_key', id: 'k' } as const;
const NOW = new Date('2026-10-01T12:00:00.000Z');
const UUID = '33333333-3333-4333-8333-333333333333';

const view = (n: number): DeliveryView => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  endpointId: UUID,
  eventId: `evt_${String(n).padStart(8, '0')}`,
  eventType: 'document.approved',
  status: 'dead',
  attemptCount: 3,
  lastStatusCode: 500,
  lastError: 'HTTP 500',
  nextAttemptAt: null,
  deliveredAt: null,
  createdAt: new Date(NOW.getTime() - n * 1000),
});

function setup(items: DeliveryView[] = [], replayResult: DeliveryView | 'not-dead' | null = null) {
  const queries: DeliveryQuery[] = [];
  const store: WebhookDeliveryAdminStore = {
    list: (_t, q) => {
      queries.push(q);
      return Promise.resolve(items.slice(0, q.limit + 1));
    },
    replay: () => Promise.resolve(replayResult),
  };
  return { service: createWebhookDeliveryService({ store, now: () => NOW }), queries };
}

/** Spec: HU-E11-01 (S5). Delivery history and replay over a store port. */
describe('webhook delivery service', () => {
  it('lists with defaults, validating filters', async () => {
    const { service, queries } = setup();
    expect(await service.list(TENANT, {})).toEqual({ items: [], nextCursor: null });
    expect(queries[0]).toEqual({ limit: 50 });
    await service.list(TENANT, { endpoint_id: UUID, status: 'dead', limit: '10' });
    expect(queries[1]).toEqual({ endpointId: UUID, status: 'dead', limit: 10 });
  });

  it.each([
    { endpoint_id: 'nope' },
    { status: 'bogus' },
    { limit: '0' },
    { limit: '101' },
    { limit: 'x' },
    { cursor: '%%%' },
    { cursor: 'e30' },
  ])('rejects the query %j', async (query) => {
    const { service } = setup();
    await expect(service.list(TENANT, query)).rejects.toBeInstanceOf(WebhookValidationError);
  });

  it('pages with an opaque keyset cursor', async () => {
    const items = [1, 2, 3].map(view);
    const { service, queries } = setup(items);
    const first = await service.list(TENANT, { limit: '2' });
    expect(first.items.map((i) => i.id)).toEqual([items[0].id, items[1].id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await service.list(TENANT, { limit: '2', cursor: first.nextCursor });
    expect(queries[1].after).toEqual({ createdAt: items[1].createdAt, id: items[1].id });
    const last = await setup(items.slice(0, 2)).service.list(TENANT, { limit: '2' });
    expect(last.nextCursor).toBeNull();
  });

  it('replays a dead delivery and distinguishes unknown from not dead', async () => {
    const replayed = { ...view(1), status: 'pending' };
    expect(await setup([], replayed).service.replay(TENANT, ACTOR, UUID)).toEqual(replayed);
    await expect(setup([], null).service.replay(TENANT, ACTOR, UUID)).rejects.toBeInstanceOf(
      WebhookEndpointNotFoundError,
    );
    await expect(setup([], 'not-dead').service.replay(TENANT, ACTOR, UUID)).rejects.toBeInstanceOf(
      WebhookDeliveryNotDeadError,
    );
    await expect(setup().service.replay(TENANT, ACTOR, 'not-a-uuid')).rejects.toBeInstanceOf(
      WebhookEndpointNotFoundError,
    );
  });
});
