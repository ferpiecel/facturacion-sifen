import { SIFEN_CODES, type SifenGateway, type SifenLoteResult } from '@sifen/sifen-gateway';

/** Lote queries are repeated at least 10 minutes apart (ADR-0007, Guía 2024). */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

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

export interface LotePollGuard {
  /** The `next_poll_at` the lote had when it was loaded; the write only applies if it still has it. */
  readonly expectedNextPollAt: Date;
  readonly polledAt: Date;
}

export interface LotePollStore {
  load(loteId: string): Promise<LotePollState | null>;
  /**
   * Atomically stores the lote transition and the document updates it implies, only while the
   * lote is still `sent` with `guard.expectedNextPollAt`. Returns false (nothing written) when a
   * concurrent poll already moved it.
   */
  record(loteId: string, outcome: LotePollOutcome, guard: LotePollGuard): Promise<boolean>;
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
  LotePollOutcome | { readonly status: 'not-found' | 'not-pollable' | 'not-due' | 'stale' };

/**
 * Queries a due lote once and decides what happens next (plan 8.1, ADR-0007):
 * 0361 keeps polling; 0362 settles each DE by `dEstRes`; 0364, 0360 or a lapsed
 * 48 h window hand the lote to HU-E6-04, which queries by CDC. A query is
 * read-only, so a failed or unexpected answer is simply retried later.
 */
export class PollLoteResult {
  constructor(private readonly deps: PollLoteResultDeps) {}

  async execute({ loteId, dId }: PollLoteResultCommand): Promise<PollLoteResultResult> {
    const lote = await this.deps.store.load(loteId);
    if (!lote) return { status: 'not-found' };
    if (lote.status !== 'sent' || !lote.dProtConsLote || !lote.nextPollAt) {
      return { status: 'not-pollable' };
    }

    const { nextPollAt } = lote;
    const now = this.now();
    if (now < nextPollAt) return { status: 'not-due' };

    if (lote.pollDeadlineAt && now > lote.pollDeadlineAt) {
      return this.settle(lote.loteId, nextPollAt, {
        status: 'recovery',
        reason: 'The 48 h lote query window elapsed; query each CDC (0364 would follow)',
      });
    }

    let answer: SifenLoteResult;
    try {
      answer = await this.deps.gateway.consultarLote({ dId, dProtConsLote: lote.dProtConsLote });
    } catch (error) {
      // Only the error class is kept: messages may carry hosts, paths or certificate details.
      const kind = error instanceof Error ? error.name : 'unknown error';
      return this.settle(lote.loteId, nextPollAt, this.pending(now, `Lote query failed (${kind})`));
    }
    return this.settle(lote.loteId, nextPollAt, this.interpret(answer, lote.cdcs, now));
  }

  private interpret(answer: SifenLoteResult, cdcs: readonly string[], now: Date): LotePollOutcome {
    switch (answer.dCodRes) {
      case SIFEN_CODES.LOTE_EN_PROCESAMIENTO:
        return this.pending(now, `${answer.dCodRes}: ${answer.dMsgRes}`);
      case SIFEN_CODES.LOTE_CONCLUIDO:
        return resolve(answer, cdcs);
      case SIFEN_CODES.CONSULTA_EXTEMPORANEA:
      case SIFEN_CODES.LOTE_INEXISTENTE:
        return { status: 'recovery', reason: `${answer.dCodRes}: ${answer.dMsgRes}` };
      default:
        return this.pending(now, `Unexpected siResultLoteDE ${answer.dCodRes}: ${answer.dMsgRes}`);
    }
  }

  private pending(now: Date, reason: string): LotePollOutcome {
    return { status: 'pending', nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS), reason };
  }

  private async settle(
    loteId: string,
    expectedNextPollAt: Date,
    outcome: LotePollOutcome,
  ): Promise<PollLoteResultResult> {
    const applied = await this.deps.store.record(loteId, outcome, {
      expectedNextPollAt,
      polledAt: this.now(),
    });
    return applied ? outcome : { status: 'stale' };
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}

function resolve(answer: SifenLoteResult, cdcs: readonly string[]): LotePollOutcome {
  const expected = new Set(cdcs);
  // Duplicates that agree collapse to the first; any disagreement or unknown dEstRes leaves the CDC unsettled.
  const byCdc = new Map<string, DocumentResolution | null>();
  for (const result of answer.resultados) {
    if (!expected.has(result.cdc)) continue;
    const status = documentStatusOf(result.dEstRes);
    const previous = byCdc.get(result.cdc);
    if (previous === null || (previous && previous.status !== status)) {
      byCdc.set(result.cdc, null);
    } else if (!previous) {
      byCdc.set(
        result.cdc,
        status && {
          cdc: result.cdc,
          status,
          messages: result.mensajes.map((m) => ({ code: m.dCodRes, message: m.dMsgRes })),
        },
      );
    }
  }
  const resolutions = [...byCdc.values()].filter((r): r is DocumentResolution => r !== null);
  const settled = new Set(resolutions.map((r) => r.cdc));
  return {
    status: 'processed',
    resolutions,
    needsRecovery: cdcs.filter((cdc) => !settled.has(cdc)),
  };
}

/** `dEstRes` is Aprobado / Aprobado con observación / Rechazado (plan 8, MT Schema XML 4). */
function documentStatusOf(dEstRes: string): DocumentResolutionStatus | null {
  const normalized = dEstRes
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
  switch (normalized) {
    case 'aprobado':
      return 'approved';
    case 'aprobado con observacion':
      return 'approved_with_observations';
    case 'rechazado':
      return 'rejected';
    default:
      return null;
  }
}
