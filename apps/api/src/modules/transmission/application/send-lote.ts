import {
  SIFEN_CODES,
  SifenTimeoutError,
  SifenTransportError,
  type SifenGateway,
} from '@sifen/sifen-gateway';
import type { Lote } from '../domain/lote-builder.js';

/** What SIFEN (or its silence) told us about a sent lote. */
export type LoteDispatchOutcome =
  | { readonly status: 'sent'; readonly dProtConsLote: string }
  | { readonly status: 'rejected'; readonly code: string; readonly reason: string }
  /** No usable answer: SIFEN may have the lote. Never resend; recover by querying (HU-E6-04). */
  | { readonly status: 'unknown'; readonly reason: string };

/** Persistence of a lote's dispatch state; implemented over `lotes_sifen` later. */
export interface LoteDispatchStore {
  /** Atomically moves `pending -> sending`; false when the lote was already claimed. */
  claim(loteId: string): Promise<boolean>;
  record(loteId: string, outcome: LoteDispatchOutcome): Promise<void>;
}

export interface SendLoteDeps {
  readonly gateway: Pick<SifenGateway, 'enviarLote'>;
  readonly store: LoteDispatchStore;
}

export interface SendLoteCommand {
  readonly loteId: string;
  readonly dId: bigint;
  readonly lote: Lote;
}

export type SendLoteResult = LoteDispatchOutcome | { readonly status: 'already-claimed' };

/** Sends a built lote to SIFEN exactly once and records the outcome (plan 8.1, ADR-0007). */
export class SendLote {
  constructor(private readonly deps: SendLoteDeps) {}

  async execute(command: SendLoteCommand): Promise<SendLoteResult> {
    if (!(await this.deps.store.claim(command.loteId))) return { status: 'already-claimed' };

    const outcome = await this.dispatch(command);
    await this.deps.store.record(command.loteId, outcome);
    return outcome;
  }

  private async dispatch({ dId, lote }: SendLoteCommand): Promise<LoteDispatchOutcome> {
    try {
      const receipt = await this.deps.gateway.enviarLote({
        dId,
        des: lote.documents.map((document) => document.xml),
      });
      return interpret(receipt);
    } catch (error) {
      if (error instanceof SifenTimeoutError || error instanceof SifenTransportError) {
        return { status: 'unknown', reason: error.message };
      }
      throw error;
    }
  }
}

function interpret(receipt: {
  dCodRes: string;
  dMsgRes: string;
  dProtConsLote: string | null;
}): LoteDispatchOutcome {
  if (receipt.dCodRes === SIFEN_CODES.LOTE_RECIBIDO && receipt.dProtConsLote) {
    return { status: 'sent', dProtConsLote: receipt.dProtConsLote };
  }
  if (receipt.dCodRes === SIFEN_CODES.LOTE_NO_ENCOLADO) {
    return { status: 'rejected', code: receipt.dCodRes, reason: receipt.dMsgRes };
  }
  return {
    status: 'unknown',
    reason: `Unexpected siRecepLoteDE response ${receipt.dCodRes}: ${receipt.dMsgRes}`,
  };
}
