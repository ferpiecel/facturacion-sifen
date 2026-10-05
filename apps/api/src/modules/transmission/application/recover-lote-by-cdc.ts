import { SIFEN_CODES, type SifenGateway } from '@sifen/sifen-gateway';
import type { DocumentResolution } from './poll-lote-result.js';

/** Queries stay at least 10 minutes apart (ADR-0007, Guía 2024), here and in the lote poll. */
const QUERY_INTERVAL_MS = 10 * 60 * 1000;
const MAX_REASON_LENGTH = 500;
const capped = (text: string): string => text.slice(0, MAX_REASON_LENGTH);

export interface LoteRecoveryState {
  readonly loteId: string;
  readonly status: string;
  /** The last lote or CDC query; recovery queries are paced from it. Null when never queried. */
  readonly lastPolledAt: Date | null;
  /** CDCs of the lote whose document is still `submitted`. */
  readonly cdcs: readonly string[];
}

export interface UnresolvedCdc {
  readonly cdc: string;
  readonly reason: string;
}

export interface LoteRecoveryOutcome {
  readonly resolutions: readonly DocumentResolution[];
  /** CDCs the query did not settle (0420, a failure or an unexpected answer): asked again later. */
  readonly unresolved: readonly UnresolvedCdc[];
}

export interface LoteRecoveryGuard {
  /** The `last_polled_at` the lote had when it was loaded; the write only applies if it still has it. */
  readonly expectedLastPolledAt: Date | null;
  readonly recoveredAt: Date;
}

export interface LoteRecoveryStore {
  load(loteId: string): Promise<LoteRecoveryState | null>;
  /**
   * Atomically settles the resolved documents and stamps the query; the lote becomes `processed`
   * when nothing is unresolved. Applies only while the lote is still `recovery` with
   * `guard.expectedLastPolledAt`; returns false (nothing written) when a concurrent run got there.
   */
  record(loteId: string, outcome: LoteRecoveryOutcome, guard: LoteRecoveryGuard): Promise<boolean>;
}

export interface RecoverLoteByCdcDeps {
  readonly gateway: Pick<SifenGateway, 'consultarDE'>;
  readonly store: LoteRecoveryStore;
  /** Reserves the SIFEN request id (`dId`) of one query. */
  readonly nextRequestId: () => Promise<bigint>;
  readonly now?: () => Date;
}

export type RecoverLoteByCdcResult =
  | ({ readonly status: 'recovered' | 'incomplete' } & LoteRecoveryOutcome)
  | { readonly status: 'not-found' | 'not-recoverable' | 'not-due' | 'stale' };

/**
 * Recovers a lote whose result query is no longer valid (0364, 0360 or 48 h elapsed) by asking
 * SIFEN for each of its documents by CDC (plan 8.1, Guía 2024): 0422 means the DE exists and is
 * approved. Nothing is ever resent: 0420 only says SIFEN does not hold an approved DE, which is
 * not proof that it never received it, so such a CDC stays unresolved and is asked again.
 */
export class RecoverLoteByCdc {
  constructor(private readonly deps: RecoverLoteByCdcDeps) {}

  async execute({ loteId }: { loteId: string }): Promise<RecoverLoteByCdcResult> {
    const lote = await this.deps.store.load(loteId);
    if (!lote) return { status: 'not-found' };
    if (lote.status !== 'recovery') return { status: 'not-recoverable' };
    const now = this.now();
    if (lote.lastPolledAt && now.getTime() < lote.lastPolledAt.getTime() + QUERY_INTERVAL_MS) {
      return { status: 'not-due' };
    }

    const resolutions: DocumentResolution[] = [];
    const unresolved: UnresolvedCdc[] = [];
    for (const cdc of lote.cdcs) {
      const answer = await this.query(cdc);
      if ('resolution' in answer) resolutions.push(answer.resolution);
      else unresolved.push({ cdc, reason: answer.reason });
    }

    const outcome = { resolutions, unresolved };
    const applied = await this.deps.store.record(loteId, outcome, {
      expectedLastPolledAt: lote.lastPolledAt,
      recoveredAt: this.now(),
    });
    if (!applied) return { status: 'stale' };
    return { status: unresolved.length === 0 ? 'recovered' : 'incomplete', ...outcome };
  }

  private async query(
    cdc: string,
  ): Promise<{ resolution: DocumentResolution } | { reason: string }> {
    try {
      const answer = await this.deps.gateway.consultarDE({
        dId: await this.deps.nextRequestId(),
        cdc: cdc as Parameters<SifenGateway['consultarDE']>[0]['cdc'],
      });
      if (answer.dCodRes === SIFEN_CODES.CDC_ENCONTRADO && answer.xmlDE?.includes(cdc)) {
        return {
          resolution: {
            cdc,
            status: 'approved',
            messages: [{ code: answer.dCodRes, message: capped(answer.dMsgRes) }],
          },
        };
      }
      return { reason: `${answer.dCodRes}: ${capped(answer.dMsgRes)}` };
    } catch (error) {
      // Only the error class is kept: messages may carry hosts, paths or certificate details.
      return { reason: `Query failed (${error instanceof Error ? error.name : 'unknown error'})` };
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
