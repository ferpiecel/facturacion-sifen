import { describe, expect, it } from 'vitest';
import { DuplicateEventIdError, MAX_EVENTS_PER_BATCH, selectEventBatch } from './event-batch.js';

const event = (n: number) => ({
  id: `row-${String(n)}`,
  eventId: BigInt(n),
  signedXml: `<e${String(n)}/>`,
});
const events = (count: number) => Array.from({ length: count }, (_, i) => event(i + 1));

describe('selectEventBatch', () => {
  it('allows 15 events per send, the limit of siRecepEvento (MT 11)', () => {
    expect(MAX_EVENTS_PER_BATCH).toBe(15);
  });

  it('takes the first 15 in order and leaves the rest for the next batch', () => {
    const batch = selectEventBatch(events(20));

    expect(batch.map((e) => e.eventId)).toEqual(
      Array.from({ length: 15 }, (_, i) => BigInt(i + 1)),
    );
  });

  it('returns what it has when there are fewer than 15, and nothing for nothing', () => {
    expect(selectEventBatch(events(3))).toHaveLength(3);
    expect(selectEventBatch([])).toEqual([]);
  });

  it('refuses a repeated event id inside the batch, naming it', () => {
    const repeated = [event(1), event(2), { ...event(3), eventId: 2n }];

    expect(() => selectEventBatch(repeated)).toThrow(DuplicateEventIdError);
    expect(() => selectEventBatch(repeated)).toThrow(/2/);
  });

  it('only looks for repeats among the events it takes', () => {
    const beyond = [...events(15), { ...event(16), eventId: 1n }];

    expect(selectEventBatch(beyond)).toHaveLength(15);
  });
});
