import { SIFEN_CODES, toCdc, type SifenGateway } from '@sifen/sifen-gateway';
import type { EventBatchStore, EventOutcome } from './send-event-batch.js';

/**
 * `response_code` of a cancellation settled as rejected because SIFEN, queried well after the send, holds no
 * such event on the document. A `LOC-` code: SIFEN never answered with it (ADR-0020).
 */
export const LOCAL_NOT_REGISTERED_CODE = 'LOC-NOEV';

/** An `unknown` cancellation: the document it targets is the thing to query. */
export interface UnresolvedCancellation {
  readonly id: string;
  readonly cdc: string;
}

/** Persistence of the recovery of events whose send got no (usable) answer; implemented over `issuer_events`. */
export interface EventRecoveryStore extends Pick<EventBatchStore, 'record'> {
  /**
   * Conditional UPDATE `sending -> unknown` for events attempted before `cutoff`: a crash between the claim and
   * the record, indistinguishable from a send that got no answer. Returns how many.
   */
  sweepStaleSending(cutoff: Date, limit: number): Promise<number>;
  /** `unknown` cancellations sent before `sentBefore`, the least recently looked at first. */
  unresolvedCancellations(
    sentBefore: Date,
    limit: number,
  ): Promise<readonly UnresolvedCancellation[]>;
  /** Notes an inconclusive query, which also moves the event to the back of the line. */
  noteInconclusive(id: string, note: string): Promise<void>;
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
 * registered is approved; one that is absent although the document exists is rejected locally; anything else
 * (a failed query, a document SIFEN does not know) stays unknown for the next pass. Voidings and nominations
 * have no document to query and stay unknown until their own stories resolve them.
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

    let approved = 0;
    let rejected = 0;
    let inconclusive = 0;
    for (const { id, cdc } of unresolved) {
      const outcome = await this.query(cdc);
      if (typeof outcome === 'string') {
        await this.deps.store.noteInconclusive(id, outcome);
        inconclusive += 1;
        continue;
      }
      await this.deps.store.record(new Map([[id, outcome]]));
      if (outcome.status === 'approved') approved += 1;
      else rejected += 1;
    }
    return { swept, approved, rejected, inconclusive };
  }

  /** The settlement, or why the query proved nothing. */
  private async query(cdc: string): Promise<string | SettledOutcome> {
    let answer;
    try {
      answer = await this.deps.gateway.consultarDE({
        dId: await this.deps.nextRequestId(),
        cdc: toCdc(cdc),
      });
    } catch (error) {
      return `query failed: ${error instanceof Error ? error.name : 'unknown error'}`;
    }
    if (answer.dCodRes !== SIFEN_CODES.CDC_ENCONTRADO) {
      return `SIFEN answered ${answer.dCodRes} to the document query`;
    }
    const registered = answer.eventos.some((evento) =>
      new RegExp(`<rGeVeCan[^>]*>\\s*<Id>${cdc}</Id>`).test(evento),
    );
    return registered
      ? {
          status: 'approved',
          code: SIFEN_CODES.EVENTO_REGISTRADO,
          message: 'SIFEN holds the cancellation (found by querying the document)',
        }
      : {
          status: 'rejected',
          code: LOCAL_NOT_REGISTERED_CODE,
          message: 'SIFEN holds no cancellation of the document',
        };
  }
}

type SettledOutcome = Extract<EventOutcome, { status: 'approved' | 'rejected' }>;
