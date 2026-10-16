import { SIFEN_CODES, type SifenGateway } from '@sifen/sifen-gateway';
import { MAX_EVENTS_PER_BATCH, selectEventBatch, type SignedEvent } from '../domain/event-batch.js';

export type PendingEvent = SignedEvent;
/** What SIFEN (or its silence) told us about one sent event; the store settles the row with it (ADR-0020). */
export type EventOutcome =
  | { readonly status: 'approved'; readonly code: string; readonly message: string }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string }
  /** No usable answer: SIFEN may hold the event. Never resent; settled later by querying. */
  | { readonly status: 'unknown'; readonly reason: string };

/** Persistence of the events of one tenant and environment; implemented over `issuer_events`. */
export interface EventBatchStore {
  /** Signed events of the tenant's current environment, oldest first (at most `limit`). */
  signedEvents(limit: number): Promise<readonly PendingEvent[]>;
  /** Atomically moves `signed -> sending` with the send's `dId`; returns those actually claimed. */
  claim(ids: readonly string[], dId: bigint): Promise<readonly PendingEvent[]>;
  record(outcomes: ReadonlyMap<string, EventOutcome>): Promise<void>;
}

export interface SendEventBatchDeps {
  readonly gateway: Pick<SifenGateway, 'enviarEventos'>;
  readonly store: EventBatchStore;
  readonly nextRequestId: () => Promise<bigint>;
  /** Checks a signed event against `siRecepEvento` before it is sent. */
  readonly validate: (xml: string) => {
    readonly valid: boolean;
    readonly errors: readonly { readonly message: string }[];
  };
}

export type SendEventBatchResult =
  | { readonly status: 'empty' }
  | {
      readonly status: 'sent';
      readonly approved: number;
      readonly rejected: number;
      readonly unknown: number;
    };

/**
 * Sends the next batch of signed issuer events to `siRecepEvento` (HU-E8-04, ADR-0020): up to 15, one send,
 * each event settled by its own answer. 0600 approves it, any other code rejects it, and no answer
 * (a transport failure, a missing result) leaves it `unknown`: never resent, because SIFEN may hold it.
 * An event that fails the XSD is rejected here (`XSD`) and not sent. If `record` fails after the send, the
 * error propagates and the events stay `sending`.
 * @throws DuplicateEventIdError before anything is claimed or sent.
 */
export class SendEventBatch {
  constructor(private readonly deps: SendEventBatchDeps) {}

  async execute(): Promise<SendEventBatchResult> {
    const candidates = await this.deps.store.signedEvents(MAX_EVENTS_PER_BATCH);
    const batch = selectEventBatch(candidates);
    if (batch.length === 0) return { status: 'empty' };

    const dId = await this.deps.nextRequestId();
    const claimed = await this.deps.store.claim(
      batch.map((event) => event.id),
      dId,
    );
    if (claimed.length === 0) return { status: 'empty' };

    const outcomes = new Map<string, EventOutcome>();
    const toSend: PendingEvent[] = [];
    for (const event of claimed) {
      const check = this.deps.validate(event.signedXml);
      if (check.valid) toSend.push(event);
      else {
        const message = check.errors[0]?.message ?? 'The event does not match siRecepEvento';
        outcomes.set(event.id, { status: 'rejected', code: 'XSD', message });
      }
    }
    if (toSend.length > 0) {
      for (const [id, outcome] of await this.dispatch(dId, toSend)) outcomes.set(id, outcome);
    }

    await this.deps.store.record(outcomes);
    const count = (status: EventOutcome['status']): number =>
      [...outcomes.values()].filter((outcome) => outcome.status === status).length;
    return {
      status: 'sent',
      approved: count('approved'),
      rejected: count('rejected'),
      unknown: count('unknown'),
    };
  }

  private async dispatch(
    dId: bigint,
    events: readonly PendingEvent[],
  ): Promise<Map<string, EventOutcome>> {
    const outcomes = new Map<string, EventOutcome>();
    try {
      const answer = await this.deps.gateway.enviarEventos({
        dId,
        eventos: events.map((event) => event.signedXml),
      });
      const byId = new Map(answer.resultados.map((result) => [result.id, result]));
      for (const event of events) {
        const message = byId.get(event.eventId.toString())?.mensajes[0];
        outcomes.set(
          event.id,
          message
            ? interpret(message)
            : { status: 'unknown', reason: 'The answer holds no result for this event' },
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const event of events) outcomes.set(event.id, { status: 'unknown', reason });
    }
    return outcomes;
  }
}

function interpret(message: { dCodRes: string; dMsgRes: string }): EventOutcome {
  const outcome = { code: message.dCodRes, message: message.dMsgRes };
  return message.dCodRes === SIFEN_CODES.EVENTO_REGISTRADO
    ? { status: 'approved', ...outcome }
    : { status: 'rejected', ...outcome };
}
