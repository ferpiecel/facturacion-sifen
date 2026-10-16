/** `siRecepEvento` takes up to 15 events of any type per call (MT v150, 11). */
export const MAX_EVENTS_PER_BATCH = 15;

/** A signed issuer event waiting to be sent. */
export interface SignedEvent {
  /** Our row id. */
  readonly id: string;
  /** `rEve/@Id`: SIFEN answers each event by it, so it cannot repeat inside a send. */
  readonly eventId: bigint;
  readonly signedXml: string;
}

export class DuplicateEventIdError extends Error {
  constructor(eventId: bigint) {
    super(`The event id ${eventId.toString()} appears twice in the same batch`);
    this.name = 'DuplicateEventIdError';
  }
}

/**
 * The events of the next send: the first 15 in the order given (oldest first), the rest wait.
 * @throws DuplicateEventIdError when two of the chosen events share an id: the answer could not be told apart.
 */
export function selectEventBatch<T extends SignedEvent>(events: readonly T[]): T[] {
  const batch = events.slice(0, MAX_EVENTS_PER_BATCH);
  const seen = new Set<bigint>();
  for (const event of batch) {
    if (seen.has(event.eventId)) throw new DuplicateEventIdError(event.eventId);
    seen.add(event.eventId);
  }
  return batch;
}
