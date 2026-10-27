import { SIFEN_CODES, toCdc, type SifenGateway } from '@sifen/sifen-gateway';
import type { EventBatchStore, EventOutcome } from './send-event-batch.js';

/**
 * `response_code` of a cancellation settled as rejected because SIFEN, queried well after the send, holds no
 * such event on the document. A `LOC-` code: SIFEN never answered with it (ADR-0020).
 */
export const LOCAL_NOT_REGISTERED_CODE = 'LOC-NOEV';

/**
 * `response_code` of an `unknown` cancellation whose document query came back WITHOUT the event once: a
 * first absence proves nothing (the event list may lag), so it only starts the clock for a confirming
 * query. `responded_at` is that query's time. Not a final outcome: the event stays `unknown`.
 */
export const ABSENCE_NOTED_CODE = 'LOC-MISS';

/** `response_code` of an `unknown` cancellation held for an operator after the 72 h window (ADR-0008). */
export const OPERATOR_HOLD_CODE = 'LOC-HOLD';

/** Event kinds that target a document, so the document query can settle them. */
export type RecoverableEventKind = 'cancellation' | 'nomination';

/** The element each recoverable kind leaves in the document's event list (`Id` holds the CDC). */
const EVENT_ELEMENT: Record<RecoverableEventKind, string> = {
  cancellation: 'rGeVeCan',
  nomination: 'rGEveNom',
};

/** An `unknown` cancellation or nomination: the document it targets is the thing to query. */
export interface UnresolvedCancellation {
  readonly id: string;
  /** Defaults to a cancellation. */
  readonly kind?: RecoverableEventKind;
  readonly cdc: string;
  /** When the send was attempted: the age the 72 h window counts from. */
  readonly sentAt: Date;
  /** When an earlier query first found the cancellation absent; null when none did. */
  readonly missedAt: Date | null;
}

/** Persistence of the recovery of events whose send got no (usable) answer; implemented over `issuer_events`. */
export interface EventRecoveryStore extends Pick<EventBatchStore, 'record'> {
  /**
   * Conditional UPDATE `sending -> unknown` for events attempted before `cutoff`: a crash between the claim and
   * the record, indistinguishable from a send that got no answer. Returns how many.
   */
  sweepStaleSending(cutoff: Date, limit: number): Promise<number>;
  /**
   * Claims `unknown` cancellations sent before `sentBefore`, the least recently looked at first, skipping
   * those held for an operator. A claim is atomic: concurrent workers get disjoint events.
   */
  unresolvedCancellations(
    sentBefore: Date,
    limit: number,
  ): Promise<readonly UnresolvedCancellation[]>;
  /** Notes an inconclusive query, which also moves the event to the back of the line. */
  noteInconclusive(id: string, note: string): Promise<void>;
  /** Notes the first absence of the cancellation on its document ({@link ABSENCE_NOTED_CODE}). */
  noteMissing(id: string, note: string): Promise<void>;
  /** Parks the event for an operator ({@link OPERATOR_HOLD_CODE}); no pass looks at it again. */
  hold(id: string, note: string): Promise<void>;
}

export interface ResolveUnknownEventsDeps {
  readonly gateway: Pick<SifenGateway, 'consultarDE'>;
  readonly store: EventRecoveryStore;
  readonly nextRequestId: () => Promise<bigint>;
  readonly now?: () => Date;
  /** A `sending` event older than this lost its outcome and becomes `unknown` (default 30 minutes). */
  readonly staleSendingAfterMs?: number;
  /** An `unknown` event is looked up only this long after its send, so the call is surely over (default 15 minutes). */
  readonly settleAfterMs?: number;
  /** Most events handled per call (default 10). */
  readonly limit?: number;
  /** A first absence is confirmed by a query at least this long after it (default 15 minutes). */
  readonly confirmAfterMs?: number;
  /** An event still unresolved this long after its send goes to an operator (default 72 hours, ADR-0008). */
  readonly holdAfterMs?: number;
  readonly logger?: { warn(message: string): void };
}

export interface ResolveUnknownEventsResult {
  readonly swept: number;
  readonly approved: number;
  readonly rejected: number;
  readonly inconclusive: number;
}

/**
 * Recovery of issuer events with no answer (HU-E8-04, ADR-0020; the same discipline as the lotes): orphan
 * `sending` events become `unknown`, and an unknown cancellation is settled by QUERYING SIFEN about its
 * document (`consultarDE`, which lists the registered events), never by resending. A cancellation found
 * registered is approved; one found absent although the document exists is rejected locally only when a later
 * pass, at least `confirmAfterMs` after the first, finds it absent again (the event list may lag); anything
 * else (a failed query, a document SIFEN does not know) stays unknown for the next pass, until the 72 h window
 * ends and the event is held for an operator. One event failing never aborts the pass. Voidings and nominations
 * have no document to query and stay unknown until their own story resolves them; a nomination is settled like a cancellation, by its own element on the document.
 */
export class ResolveUnknownEvents {
  constructor(private readonly deps: ResolveUnknownEventsDeps) {}

  async execute(): Promise<ResolveUnknownEventsResult> {
    const now = (this.deps.now ?? (() => new Date()))().getTime();
    const limit = this.deps.limit ?? 10;
    const swept = await this.deps.store.sweepStaleSending(
      new Date(now - (this.deps.staleSendingAfterMs ?? 30 * 60_000)),
      limit,
    );
    const unresolved = await this.deps.store.unresolvedCancellations(
      new Date(now - (this.deps.settleAfterMs ?? 15 * 60_000)),
      limit,
    );

    const confirmAfterMs = this.deps.confirmAfterMs ?? 15 * 60_000;
    const holdAfterMs = this.deps.holdAfterMs ?? 72 * 3_600_000;
    let approved = 0;
    let rejected = 0;
    let inconclusive = 0;
    for (const event of unresolved) {
      try {
        const answer = await this.query(event.cdc, event.kind ?? 'cancellation');
        const outcome = this.decide(answer, event, now, confirmAfterMs);
        if (outcome.kind === 'settled') {
          await this.deps.store.record(new Map([[event.id, outcome.outcome]]));
          if (outcome.outcome.status === 'approved') approved += 1;
          else rejected += 1;
          continue;
        }
        inconclusive += 1;
        if (now - event.sentAt.getTime() > holdAfterMs) {
          this.deps.logger?.warn(`issuer event ${event.id} unresolved past the window; held`);
          await this.deps.store.hold(event.id, outcome.note);
        } else if (outcome.kind === 'absent') {
          await this.deps.store.noteMissing(event.id, outcome.note);
        } else {
          await this.deps.store.noteInconclusive(event.id, outcome.note);
        }
      } catch (error) {
        // The store failed for this event (a conflict, a dropped connection): it must not block the queue.
        inconclusive += 1;
        this.deps.logger?.warn(
          `issuer event ${event.id} not resolved: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
        await this.deps.store
          .noteInconclusive(event.id, 'resolution failed')
          .catch(() => undefined);
      }
    }
    return { swept, approved, rejected, inconclusive };
  }

  private decide(
    answer: Answer,
    event: UnresolvedCancellation,
    now: number,
    confirmAfterMs: number,
  ): Answer {
    if (answer.kind !== 'absent') return answer;
    const first = event.missedAt;
    if (first === null) return answer;
    if (now - first.getTime() < confirmAfterMs) {
      // Too soon to be an independent confirmation; keep the first absence's clock.
      return { kind: 'inconclusive', note: 'The cancellation is still absent; waiting to confirm' };
    }
    return {
      kind: 'settled',
      outcome: {
        status: 'rejected',
        code: LOCAL_NOT_REGISTERED_CODE,
        message: 'SIFEN holds no cancellation of the document (confirmed by two queries)',
      },
    };
  }

  /** What the document query proved about the cancellation. */
  private async query(cdc: string, kind: RecoverableEventKind): Promise<Answer> {
    let answer;
    try {
      answer = await this.deps.gateway.consultarDE({
        dId: await this.deps.nextRequestId(),
        cdc: toCdc(cdc),
      });
    } catch (error) {
      return {
        kind: 'inconclusive',
        note: `query failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      };
    }
    if (answer.dCodRes !== SIFEN_CODES.CDC_ENCONTRADO) {
      return {
        kind: 'inconclusive',
        note: `SIFEN answered ${answer.dCodRes} to the document query`,
      };
    }
    // Element names may carry a namespace prefix (`<ns2:rGeVeCan>`).
    const cancellation = new RegExp(
      `<(?:[\\w.-]+:)?${EVENT_ELEMENT[kind]}[^>]*>\\s*<(?:[\\w.-]+:)?Id>\\s*${cdc}\\s*</`,
    );
    return answer.eventos.some((evento) => cancellation.test(evento))
      ? {
          kind: 'settled',
          outcome: {
            status: 'approved',
            code: SIFEN_CODES.EVENTO_REGISTRADO,
            message: `SIFEN holds the ${kind} (found by querying the document)`,
          },
        }
      : { kind: 'absent', note: `SIFEN holds no ${kind} of the document (to confirm)` };
  }
}

type SettledOutcome = Extract<EventOutcome, { status: 'approved' | 'rejected' }>;
type Answer =
  | { readonly kind: 'settled'; readonly outcome: SettledOutcome }
  | { readonly kind: 'absent'; readonly note: string }
  | { readonly kind: 'inconclusive'; readonly note: string };
