import { SIFEN_CODES, type SifenGateway } from '@sifen/sifen-gateway';
import type { DocumentResolution } from './poll-lote-result.js';

/** Queries stay at least 10 minutes apart (ADR-0007, Guía 2024), here and in the lote poll. */
const QUERY_INTERVAL_MS = 10 * 60 * 1000;
/**
 * `recovery`: the result query lapsed (0364, 48 h). `unknown`: the send got no answer, so there is no
 * protocol to query. `processed`: the poll closed it with documents it could not settle.
 */
const RECOVERABLE_STATUSES: ReadonlySet<string> = new Set(['recovery', 'unknown', 'processed']);
const MAX_REASON_LENGTH = 500;
const capped = (text: string): string => text.slice(0, MAX_REASON_LENGTH);

export interface LoteRecoveryState {
  readonly loteId: string;
  readonly status: string;
  /** The last lote or CDC query; recovery queries are paced from it. Null when never queried. */
  readonly lastPolledAt: Date | null;
  /** CDCs of the lote whose document SIFEN may still owe an answer for (`queued` in an `unknown` lote, else `submitted`). */
  readonly cdcs: readonly string[];
}

export interface UnresolvedCdc {
  readonly cdc: string;
  readonly reason: string;
  /** SIFEN answered 0420 (no approved DE): the only answer that counts toward holding the document. */
  readonly absent?: boolean;
  /** Not asked in this pass (query cap reached or run aborted): still pending, says nothing about SIFEN. */
  readonly skipped?: true;
}

export interface LoteRecoveryOutcome {
  readonly resolutions: readonly DocumentResolution[];
  /** CDCs the query did not settle (0420, a failure or an unexpected answer): asked again later. */
  readonly unresolved: readonly UnresolvedCdc[];
}

export interface LoteRecoveryGuard {
  /** The status the lote had when it was loaded; the write only applies while it still has it. */
  readonly expectedStatus: string;
  /** The `last_polled_at` the lote had when it was loaded; the write only applies if it still has it. */
  readonly expectedLastPolledAt: Date | null;
  readonly recoveredAt: Date;
}

export interface LoteRecoveryStore {
  load(loteId: string): Promise<LoteRecoveryState | null>;
  /**
   * Atomically settles the resolved documents and stamps the query; the lote becomes `processed`
   * when nothing is unresolved, otherwise it keeps its status. Applies only while the lote still has
   * `guard.expectedStatus` and `guard.expectedLastPolledAt`; returns false (nothing written) when a concurrent run got there.
   */
  record(loteId: string, outcome: LoteRecoveryOutcome, guard: LoteRecoveryGuard): Promise<boolean>;
}

export interface RecoverLoteByCdcDeps {
  readonly gateway: Pick<SifenGateway, 'consultarDE'>;
  readonly store: LoteRecoveryStore;
  /** Reserves the SIFEN request id (`dId`) of one query. */
  readonly nextRequestId: () => Promise<bigint>;
  readonly now?: () => Date;
  /**
   * Most `consultarDE` calls per execution (default 20). Calls are sequential and a SOAP call may take
   * up to its timeout, so an unbounded lote of 50 CDCs could hold the tenant run lock for minutes;
   * 20 keeps a pass near a minute at normal latency and a lote of 50 settles in three 10-minute passes.
   * The cycle bounds the lotes per run (`batch.recover`), so a run asks at most `recover x maxQueries`.
   */
  readonly maxQueries?: number;
}

const DEFAULT_MAX_QUERIES = 20;

export type RecoverLoteByCdcResult =
  | ({ readonly status: 'recovered' | 'incomplete' } & LoteRecoveryOutcome)
  | { readonly status: 'not-found' | 'not-recoverable' | 'not-due' | 'stale' | 'aborted' };

/** The `Id` attribute of the DE element: the document's own CDC, not any CDC it merely references. */
function deIdOf(xml: string): string | undefined {
  return /<DE\b[^>]*\bId="([^"]*)"/.exec(xml)?.[1];
}

/**
 * Recovers a lote whose outcome SIFEN never confirmed (0364, 0360, 48 h elapsed, a send without answer, or documents the poll left unsettled) by asking
 * SIFEN for each of its documents by CDC (plan 8.1, Guía 2024): 0422 means the DE exists and is
 * approved. Nothing is ever resent: 0420 only says SIFEN does not hold an approved DE, which is
 * not proof that it never received it, so such a CDC stays unresolved and is asked again.
 */
export class RecoverLoteByCdc {
  constructor(private readonly deps: RecoverLoteByCdcDeps) {}

  async execute({
    loteId,
    signal,
  }: {
    loteId: string;
    /** The cycle's run signal: when the tenant run lock is lost no further query starts. */
    signal?: AbortSignal;
  }): Promise<RecoverLoteByCdcResult> {
    if (signal?.aborted) return { status: 'aborted' };
    const lote = await this.deps.store.load(loteId);
    if (!lote) return { status: 'not-found' };
    if (!RECOVERABLE_STATUSES.has(lote.status)) return { status: 'not-recoverable' };
    // A finished lote is only recoverable while it still holds documents SIFEN owes an answer for.
    if (lote.status === 'processed' && lote.cdcs.length === 0) return { status: 'not-recoverable' };
    const now = this.now();
    if (lote.lastPolledAt && now.getTime() < lote.lastPolledAt.getTime() + QUERY_INTERVAL_MS) {
      return { status: 'not-due' };
    }

    const resolutions: DocumentResolution[] = [];
    const unresolved: UnresolvedCdc[] = [];
    const cap = this.deps.maxQueries ?? DEFAULT_MAX_QUERIES;
    for (const [index, cdc] of lote.cdcs.entries()) {
      if (index >= cap || signal?.aborted) {
        unresolved.push({ cdc, reason: 'Not queried in this pass', skipped: true });
        continue;
      }
      const answer = await this.query(cdc);
      if ('resolution' in answer) resolutions.push(answer.resolution);
      else unresolved.push({ cdc, ...answer });
    }

    const outcome = { resolutions, unresolved };
    const applied = await this.deps.store.record(loteId, outcome, {
      expectedStatus: lote.status,
      expectedLastPolledAt: lote.lastPolledAt,
      recoveredAt: this.now(),
    });
    if (!applied) return { status: 'stale' };
    return { status: unresolved.length === 0 ? 'recovered' : 'incomplete', ...outcome };
  }

  private async query(
    cdc: string,
  ): Promise<{ resolution: DocumentResolution } | { reason: string; absent: boolean }> {
    try {
      const answer = await this.deps.gateway.consultarDE({
        dId: await this.deps.nextRequestId(),
        cdc: cdc as Parameters<SifenGateway['consultarDE']>[0]['cdc'],
      });
      if (
        answer.dCodRes === SIFEN_CODES.CDC_ENCONTRADO &&
        answer.xmlDE !== null &&
        deIdOf(answer.xmlDE) === cdc
      ) {
        return {
          resolution: {
            cdc,
            status: 'approved',
            messages: [{ code: answer.dCodRes, message: capped(answer.dMsgRes) }],
          },
        };
      }
      return {
        reason: `${answer.dCodRes}: ${capped(answer.dMsgRes)}`,
        absent: answer.dCodRes === SIFEN_CODES.CDC_INEXISTENTE,
      };
    } catch (error) {
      // Only the error class is kept: messages may carry hosts, paths or certificate details.
      return {
        reason: `Query failed (${error instanceof Error ? error.name : 'unknown error'})`,
        absent: false,
      };
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
