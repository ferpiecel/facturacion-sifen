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
  it('lists the v1.0 §13 events plus the v1.1 §19 additions (v1.1 adds, it does not replace)', () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual([
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
    ]);
  });

  it.each([
    ['a bigint', { n: 1n }],
    ['a function', { f: () => 1 }],
    ['undefined', { u: undefined }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['a Date', { d: new Date() }],
    ['a Map', { m: new Map() }],
    [
      'a class instance',
      {
        c: new (class X {
          a = 1;
        })(),
      },
    ],
    ['a symbol', { s: Symbol('x') }],
    ['an array holding a bigint', { a: [1n] }],
  ])('rejects data holding %s', (_name, data) => {
    expect(() => createWebhookEvent({ ...base, data })).toThrow(InvalidWebhookEventError);
  });

  it('rejects circular and absurdly deep data', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => createWebhookEvent({ ...base, data: circular })).toThrow(InvalidWebhookEventError);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) deep = { deep };
    expect(() => createWebhookEvent({ ...base, data: deep })).toThrow(InvalidWebhookEventError);
  });

  it('accepts nested plain JSON values', () => {
    const data = { a: [1, 'x', null, true, { b: 2.5 }], c: { d: null } };
    expect(createWebhookEvent({ ...base, data }).data).toEqual(data);
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
