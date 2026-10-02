import { describe, expect, it } from 'vitest';
import {
  InvalidWebhookEventError,
  WEBHOOK_EVENT_TYPES,
  createWebhookEvent,
  matchesEventFilter,
  serializeWebhookEvent,
} from './webhook-event.js';

const base = {
  id: 'evt_01HZ0000000000000000000000',
  type: 'document.approved',
  createdAt: new Date('2026-09-22T17:30:00.000Z'),
  tenantId: 'tnt_1',
  data: { cdc: '0'.repeat(44) },
};

describe('webhook event envelope (HU-E11-01)', () => {
  it('lists the lifecycle events of the plan (§19)', () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual([
      'document.approved',
      'document.approved_with_observations',
      'document.rejected',
      'document.cancelled',
      'document.number_voided',
      'document.transmission_deadline_warning',
    ]);
  });

  it('builds the envelope with a UTC ISO created_at', () => {
    expect(createWebhookEvent(base)).toEqual({
      id: base.id,
      type: 'document.approved',
      created_at: '2026-09-22T17:30:00.000Z',
      tenant_id: 'tnt_1',
      data: base.data,
    });
  });

  it.each([
    { type: 'document.exploded' },
    { id: 'x' },
    { id: 'evt_' },
    { tenantId: '' },
    { createdAt: new Date(Number.NaN) },
  ])('rejects an invalid envelope %j', (override) => {
    expect(() => createWebhookEvent({ ...base, ...override })).toThrow(InvalidWebhookEventError);
  });

  it('serializes to the exact bytes that get signed (stable JSON)', () => {
    const body = serializeWebhookEvent(createWebhookEvent(base));
    expect(JSON.parse(body)).toEqual(createWebhookEvent(base));
    expect(body).toBe(serializeWebhookEvent(createWebhookEvent(base)));
  });

  it('matches an endpoint filter; an empty filter subscribes to everything', () => {
    expect(matchesEventFilter([], 'document.rejected')).toBe(true);
    expect(matchesEventFilter(['document.approved'], 'document.approved')).toBe(true);
    expect(matchesEventFilter(['document.approved'], 'document.rejected')).toBe(false);
  });
});
