import { WEBHOOK_EVENT_TYPES as DB_EVENT_TYPES } from '@sifen/db';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_TYPES } from '../domain/webhook-event.js';

describe('webhook event types (HU-E11-01)', () => {
  it('match the list the database constrains endpoints and deliveries to', () => {
    expect([...DB_EVENT_TYPES]).toEqual([...WEBHOOK_EVENT_TYPES]);
  });
});
