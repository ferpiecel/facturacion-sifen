import { nextRequestId, type TenantTx } from '@sifen/db';

const IDEMPOTENCY_INDEX = 'issuer_events_idempotency_idx';
const RECEIVER_OPEN_INDEX = 'issuer_events_receiver_open_idx';
/** MT v150 GDE003: `rEve/@Id` has at most 10 digits. */
const MAX_EVENT_ID = 9_999_999_999n;

/** The tenant's `dId` counter passed the 10 digits an event id may have. */
export class EventIdExhaustedError extends Error {
  constructor() {
    super('The tenant ran out of event ids');
    this.name = 'EventIdExhaustedError';
  }
}

/** First row of a result, typed as possibly missing. */
export function first<T>(rows: T[]): T | undefined {
  return rows.at(0);
}

/** Whether `error` (or its cause chain) is the unique violation of the event idempotency key. */
export function isKeyCollision(error: unknown): boolean {
  return violates(error, IDEMPOTENCY_INDEX);
}

/** Whether `error` (or its cause chain) is the unique violation of one open receiver event per CDC and kind. */
export function isReceiverDuplicate(error: unknown): boolean {
  return violates(error, RECEIVER_OPEN_INDEX);
}

function violates(error: unknown, index: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { constraint, cause } = error as { constraint?: unknown; cause?: unknown };
  return constraint === index || violates(cause, index);
}

/** Takes the tenant's next event id (`rEve/@Id`) inside the caller's transaction. */
export async function takeEventId(
  tx: TenantTx,
  tenantId: string,
  environment: 'test' | 'production',
): Promise<bigint> {
  const eventId = await nextRequestId(tx, tenantId, environment);
  if (eventId > MAX_EVENT_ID) throw new EventIdExhaustedError();
  return eventId;
}
