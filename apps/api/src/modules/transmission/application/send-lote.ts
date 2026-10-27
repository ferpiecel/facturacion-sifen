import { SIFEN_CODES, SifenCircuitOpenError, type SifenGateway } from '@sifen/sifen-gateway';
import { EmptyLoteError, type Lote } from '../domain/lote-builder.js';
import { documentStatusOf, type DocumentResolution } from './poll-lote-result.js';
import { isRucBlockMessage } from './ruc-block.js';

/** What SIFEN (or its silence) told us about a sent lote. */
export type LoteDispatchOutcome =
  | { readonly status: 'sent'; readonly dProtConsLote: string }
  | {
      readonly status: 'rejected';
      readonly code: string;
      readonly reason: string;
      /** The refusal says SIFEN blocked the RUC (HU-E6-05): the tenant's sends pause for a while. */
      readonly rucBlocked?: true;
    }
  /** The synchronous send (HU-E6-06) answered with the document's final state. */
  | { readonly status: 'processed'; readonly resolution: DocumentResolution }
  /** No usable answer: SIFEN may have the lote. Never resend; recover by querying (HU-E6-04). */
  | { readonly status: 'unknown'; readonly reason: string; readonly cause?: unknown };

/** What `record` stores: a `processed` answer is settled by `SyncDispatch.recordSettled` instead. */
export type RecordedOutcome = Exclude<LoteDispatchOutcome, { readonly status: 'processed' }>;

/** Persistence of a lote's dispatch state; implemented over `lotes_sifen` later. */
export interface LoteDispatchStore {
  /** Atomically moves `pending -> sending`; false when the lote was already claimed. */
  claim(loteId: string): Promise<boolean>;
  /** Returns a claimed lote to `pending` when nothing was sent, with no attempt counted. */
  release(loteId: string): Promise<void>;
  record(loteId: string, outcome: RecordedOutcome): Promise<void>;
}

/** The tenant's opt-in to siRecepDE (HU-E6-06); implemented over the fiscal profile and `lotes`. */
export interface SyncDispatch {
  isEnabled(): Promise<boolean>;
  /** SIFEN answered 1264: clears the flag (audited) so later sends go by lote. */
  disable(reason: string): Promise<void>;
  /** Settles the claimed lote and its single document from the synchronous answer, in one transaction. */
  recordSettled(loteId: string, resolution: DocumentResolution): Promise<void>;
}

export interface SendLoteDeps {
  readonly gateway: Pick<SifenGateway, 'enviarLote' | 'enviarDESincronico'>;
  /** Absent: every lote goes by batch. */
  readonly sync?: SyncDispatch;
  readonly store: LoteDispatchStore;
  /**
   * When the send endpoint is paused by its circuit breaker, the instant it may be tried again;
   * `null` when sending is allowed. Checked before the claim, so a paused endpoint leaves no trace.
   */
  readonly pausedUntil?: () => Date | null;
}

export interface SendLoteCommand {
  readonly loteId: string;
  readonly dId: bigint;
  readonly lote: Lote;
}

/** The endpoint's circuit is open: nothing was claimed or sent; the lote stays `pending` until `retryAt`. */
export interface LoteDeferred {
  readonly status: 'deferred';
  readonly retryAt: Date;
}

export type SendLoteResult =
  LoteDispatchOutcome | LoteDeferred | { readonly status: 'already-claimed' };

/**
 * Sends a built lote to SIFEN exactly once and records the outcome (plan 8.1, ADR-0007).
 * If `record` fails after the send, the error propagates and the lote stays `sending`;
 * HU-E6-04 recovers a stale `sending` lote as `unknown` by querying SIFEN. Never resent.
 * An open circuit (HU-E6-08) defers before the claim: the lote stays `pending`. If the circuit opens
 * between that check and the call, the gateway refuses without sending: the claim is released back to
 * `pending` and the result is `deferred`, so the lote keeps its 72 h window.
 * @throws EmptyLoteError before anything is claimed or sent.
 */
export class SendLote {
  constructor(private readonly deps: SendLoteDeps) {}

  async execute(command: SendLoteCommand): Promise<SendLoteResult> {
    if (command.lote.documents.length === 0) throw new EmptyLoteError();
    const retryAt = this.deps.pausedUntil?.() ?? null;
    if (retryAt) return { status: 'deferred', retryAt };
    if (!(await this.deps.store.claim(command.loteId))) return { status: 'already-claimed' };

    const synchronous = await this.dispatchSync(command);
    if (synchronous && synchronous.status === 'processed') return synchronous;
    const outcome = synchronous ?? (await this.dispatch(command));
    if (outcome.status === 'deferred') {
      await this.deps.store.release(command.loteId);
      return outcome;
    }
    await this.deps.store.record(command.loteId, outcome);
    return outcome;
  }

  /**
   * A lote of one DE of a flagged tenant goes through siRecepDE. Returns undefined when the batch path
   * must run instead (no flag, several DEs, or 1264, which clears the flag first). After a 'processed'
   * answer the settlement is already stored; any other outcome is recorded by the caller.
   */
  private async dispatchSync({
    dId,
    lote,
    loteId,
  }: SendLoteCommand): Promise<LoteDispatchOutcome | LoteDeferred | undefined> {
    const sync = this.deps.sync;
    const [document] = lote.documents;
    if (!sync || lote.documents.length !== 1 || !(await sync.isEnabled())) {
      return undefined;
    }
    try {
      const answer = await this.deps.gateway.enviarDESincronico({ dId, de: document.xml });
      if (answer.dCodRes === SIFEN_CODES.RUC_NO_HABILITADO_SINCRONICO) {
        // Nothing was processed: even if the flag cannot be cleared the lote still goes by batch.
        await sync
          .disable(`${answer.dCodRes}: ${answer.dMsgRes}`.slice(0, 500))
          .catch(() => undefined);
        return undefined;
      }
      const status = documentStatusOf(answer.dEstRes ?? '');
      if (!status) {
        return {
          status: 'unknown',
          reason: `Unexpected siRecepDE response ${answer.dCodRes}: ${answer.dMsgRes}`,
        };
      }
      const resolution: DocumentResolution = {
        cdc: document.cdc,
        status,
        messages: [{ code: answer.dCodRes, message: answer.dMsgRes }],
      };
      await sync.recordSettled(loteId, resolution);
      return { status: 'processed', resolution };
    } catch (error) {
      if (error instanceof SifenCircuitOpenError) {
        return { status: 'deferred', retryAt: error.retryAt };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'unknown', reason, cause: error };
    }
  }

  private async dispatch({ dId, lote }: SendLoteCommand): Promise<RecordedOutcome | LoteDeferred> {
    try {
      const receipt = await this.deps.gateway.enviarLote({
        dId,
        des: lote.documents.map((document) => document.xml),
      });
      return interpret(receipt);
    } catch (error) {
      // The breaker refused locally: nothing reached SIFEN, so the lote is not `unknown`.
      if (error instanceof SifenCircuitOpenError) {
        return { status: 'deferred', retryAt: error.retryAt };
      }
      // Once the call started SIFEN may hold the lote, whatever went wrong: never resend.
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'unknown', reason, cause: error };
    }
  }
}

function interpret(receipt: {
  dCodRes: string;
  dMsgRes: string;
  dProtConsLote: string | null;
}): RecordedOutcome {
  if (receipt.dCodRes === SIFEN_CODES.LOTE_RECIBIDO && receipt.dProtConsLote) {
    return { status: 'sent', dProtConsLote: receipt.dProtConsLote };
  }
  if (receipt.dCodRes === SIFEN_CODES.LOTE_NO_ENCOLADO) {
    return {
      status: 'rejected',
      code: receipt.dCodRes,
      reason: receipt.dMsgRes,
      ...(isRucBlockMessage(receipt.dMsgRes) ? { rucBlocked: true as const } : {}),
    };
  }
  return {
    status: 'unknown',
    reason: `Unexpected siRecepLoteDE response ${receipt.dCodRes}: ${receipt.dMsgRes}`,
  };
}
