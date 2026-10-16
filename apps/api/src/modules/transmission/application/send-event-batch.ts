import { SIFEN_CODES, type SifenGateway } from '@sifen/sifen-gateway';
import { MAX_EVENTS_PER_BATCH, selectEventBatch, type SignedEvent } from '../domain/event-batch.js';

export type PendingEvent = SignedEvent;

/**
 * `response_code` of an event rejected here, before it was sent (ADR-0020). SIFEN codes are 4 digits, so a
 * `LOC-` prefix never collides with one; whoever settles an event tells a local refusal from SIFEN's by it.
 */
export const LOCAL_XSD_CODE = 'LOC-XSD';

/**
 * Codes that mean SIFEN already holds the effect of the event (4003 same cancellation requested again, 4453
 * same nomination): an idempotent success, settled as approved with the real code so the open event keeps
 * the partial unique index. PROVISIONAL until T0 confirms the list with the Prevalidador; the voiding
 * counterpart (4066) is left out because it also answers a partial overlap.
 */
export const ALREADY_PROCESSED_CODES: ReadonlySet<string> = new Set(['4003', '4453']);
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
  /** Settles events that failed the XSD as rejected without sending them: no batch id, a local code. */
  rejectUnsent(rejections: ReadonlyMap<string, { code: string; message: string }>): Promise<void>;
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

    // Validate before claiming: an event that cannot be sent never gets a batch id. A validator that
    // throws proves nothing about the event, so it stays signed for the next run.
    const valid: PendingEvent[] = [];
    const refused = new Map<string, { code: string; message: string }>();
    for (const event of batch) {
      try {
        const check = this.deps.validate(event.signedXml);
        if (check.valid) valid.push(event);
        else {
          const message = check.errors.at(0)?.message ?? 'The event does not match siRecepEvento';
          refused.set(event.id, { code: LOCAL_XSD_CODE, message });
        }
      } catch {
        continue;
      }
    }
    if (refused.size > 0) await this.deps.store.rejectUnsent(refused);

    const outcomes = new Map<string, EventOutcome>();
    if (valid.length > 0) {
      const dId = await this.deps.nextRequestId();
      const claimed = await this.deps.store.claim(
        valid.map((event) => event.id),
        dId,
      );
      if (claimed.length > 0) {
        for (const [id, outcome] of await this.dispatch(dId, claimed)) outcomes.set(id, outcome);
        await this.deps.store.record(outcomes);
      }
    }
    if (outcomes.size === 0 && refused.size === 0) return { status: 'empty' };

    const count = (status: EventOutcome['status']): number =>
      [...outcomes.values()].filter((outcome) => outcome.status === status).length;
    return {
      status: 'sent',
      approved: count('approved'),
      rejected: count('rejected') + refused.size,
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
        const result = byId.get(event.eventId.toString());
        outcomes.set(
          event.id,
          result
            ? interpret(result)
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

/** Reads the state (`dEstRes`) and every message of one event's result; a contradiction is not guessed at. */
function interpret(result: {
  dEstRes: string;
  mensajes: readonly { dCodRes: string; dMsgRes: string }[];
}): EventOutcome {
  const state = result.dEstRes.trim().toLowerCase();
  const unknown = (reason: string): EventOutcome => ({ status: 'unknown', reason });
  if (result.mensajes.length === 0) return unknown('The result of the event carries no message');

  const already = result.mensajes.find((m) => ALREADY_PROCESSED_CODES.has(m.dCodRes));
  if (already) return { status: 'approved', code: already.dCodRes, message: already.dMsgRes };

  const registered = result.mensajes.find((m) => m.dCodRes === SIFEN_CODES.EVENTO_REGISTRADO);
  if (state.startsWith('aprobado')) {
    return registered
      ? { status: 'approved', code: registered.dCodRes, message: registered.dMsgRes }
      : unknown(`Approved without ${SIFEN_CODES.EVENTO_REGISTRADO}`);
  }
  if (state === 'rechazado') {
    const first = result.mensajes[0];
    return registered
      ? unknown(`Rejected with ${SIFEN_CODES.EVENTO_REGISTRADO}`)
      : { status: 'rejected', code: first.dCodRes, message: first.dMsgRes };
  }
  return unknown(`Unknown result state "${result.dEstRes}"`);
}
