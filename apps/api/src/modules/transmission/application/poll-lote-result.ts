import type { SifenGateway } from '@sifen/sifen-gateway';

export type DocumentResolutionStatus = 'approved' | 'approved_with_observations' | 'rejected';

export interface SifenMessage {
  readonly code: string;
  readonly message: string;
}

export interface DocumentResolution {
  readonly cdc: string;
  readonly status: DocumentResolutionStatus;
  readonly messages: readonly SifenMessage[];
}

export type LotePollOutcome =
  | { readonly status: 'pending'; readonly nextPollAt: Date; readonly reason: string }
  | {
      readonly status: 'processed';
      readonly resolutions: readonly DocumentResolution[];
      /** CDCs the answer did not settle (missing or unknown `dEstRes`); HU-E6-04 queries them. */
      readonly needsRecovery: readonly string[];
    }
  | { readonly status: 'recovery'; readonly reason: string };

export interface LotePollState {
  readonly loteId: string;
  readonly status: string;
  readonly dProtConsLote: string | null;
  readonly nextPollAt: Date | null;
  readonly pollDeadlineAt: Date | null;
  readonly cdcs: readonly string[];
}

export interface LotePollStore {
  load(loteId: string): Promise<LotePollState | null>;
  /** Atomically stores the lote transition and the document updates it implies. */
  record(loteId: string, outcome: LotePollOutcome): Promise<void>;
}

export interface PollLoteResultDeps {
  readonly gateway: Pick<SifenGateway, 'consultarLote'>;
  readonly store: LotePollStore;
  readonly now?: () => Date;
}

export interface PollLoteResultCommand {
  readonly loteId: string;
  readonly dId: bigint;
}

export type PollLoteResultResult =
  LotePollOutcome | { readonly status: 'not-found' | 'not-pollable' | 'not-due' };

export class PollLoteResult {
  constructor(private readonly deps: PollLoteResultDeps) {}

  execute(_command: PollLoteResultCommand): Promise<PollLoteResultResult> {
    return Promise.reject(new Error('not implemented'));
  }
}
