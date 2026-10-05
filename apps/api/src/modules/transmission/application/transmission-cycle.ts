import type { SignDocument } from '../../emission/application/sign-document.js';
import type { Lote } from '../domain/lote-builder.js';
import type { LoteAssembler } from './assemble-lotes.js';
import type { PollLoteResult } from './poll-lote-result.js';
import type { RecoverLoteByCdc } from './recover-lote-by-cdc.js';
import type { SendLote } from './send-lote.js';

/** A `pending` lote with the signed documents it carries, ready for `SendLote`. */
export interface PendingLote {
  readonly loteId: string;
  readonly lote: Lote;
}

/** What the cycle needs to find work; implemented over Postgres, scoped to one tenant. */
export interface TransmissionCycleStore {
  /** Documents still `accepted` (to sign) in the tenant's current environment, oldest first. */
  acceptedDocumentIds(limit: number): Promise<readonly string[]>;
  /** `pending` lotes, oldest first. */
  pendingLotes(limit: number): Promise<readonly PendingLote[]>;
  /** `sent` lotes whose next query time has come, most overdue first. */
  dueLoteIds(now: Date, limit: number): Promise<readonly string[]>;
  /** `recovery` lotes never queried by CDC or not in the last 10 minutes, never-queried first. */
  recoverableLoteIds(now: Date, limit: number): Promise<readonly string[]>;
  /** Reserves the next SIFEN request id (`dId`) for the tenant and environment. */
  nextRequestId(): Promise<bigint>;
  /** Stops signing an `accepted` document until an operator clears it; `reason` is a plain code. */
  holdDocument(documentId: string, reason: string): Promise<void>;
  /** Documents parked for operator attention (signing poison, 0301 retries exhausted). */
  heldDocuments(limit: number): Promise<readonly HeldDocument[]>;
  /** Moves a `pending` lote that failed to send behind the others, so it cannot starve them. */
  deferPendingLote(loteId: string): Promise<void>;
  /** `pending` lotes created before `cutoff`: a send that keeps failing, or a crash before it. */
  pendingOlderThan(cutoff: Date): Promise<number>;
}

export interface HeldDocument {
  readonly documentId: string;
  readonly reason: string;
}

/**
 * Errors that repeat for the same document until configuration or data change (HU-E5/E6): the
 * document is parked instead of retried. Matched by class name because some live in infrastructure.
 */
const DETERMINISTIC_SIGNING_ERRORS: ReadonlySet<string> = new Set([
  'SigningDataIncompleteError',
  'EstablishmentContactMissingError',
  'CscNotConfiguredError',
  'DocumentEnvironmentMismatchError',
  'CertificateNotFoundError',
  'CertificateValidityError',
  'InvoiceXmlError',
  'InvoiceQrError',
  'SigningMismatchError',
]);

export interface TransmissionCycleBatch {
  readonly sign?: number;
  readonly send?: number;
  readonly poll?: number;
  readonly recover?: number;
}

export interface TransmissionCycleDeps {
  readonly tenantId: string;
  readonly store: TransmissionCycleStore;
  readonly signer: Pick<SignDocument, 'execute'>;
  readonly assembler: Pick<LoteAssembler, 'assemble'>;
  readonly sender: Pick<SendLote, 'execute'>;
  readonly poller: Pick<PollLoteResult, 'execute'>;
  readonly recoverer: Pick<RecoverLoteByCdc, 'execute'>;
  readonly batch?: TransmissionCycleBatch;
  readonly now?: () => Date;
  /** A `pending` lote older than this is reported as stale (default 15 minutes). */
  readonly stalePendingAfterMs?: number;
  readonly logger?: { warn(message: string): void };
}

export type CycleStep = 'sign' | 'assemble' | 'send' | 'poll' | 'recover';

export interface CycleFailure {
  readonly step: CycleStep;
  /** Document or lote the failure belongs to; absent when the whole step failed. */
  readonly id?: string;
  /** Error class only: messages may carry hosts, paths or key material. */
  readonly error: string;
}

export interface CycleReport {
  readonly signed: number;
  readonly signSkipped: number;
  readonly assembled: number;
  /** Lotes another worker had already claimed: not sent by this run. */
  readonly sendSkipped: number;
  readonly sent: readonly { readonly loteId: string; readonly status: string }[];
  readonly polled: readonly { readonly loteId: string; readonly status: string }[];
  /** Lotes queried by CDC after 0364 or the 48 h window (HU-E6-04). */
  readonly recovered: readonly { readonly loteId: string; readonly status: string }[];
  readonly failures: readonly CycleFailure[];
  /** Documents parked for an operator, as of the end of the run. */
  readonly held: readonly HeldDocument[];
  /** `pending` lotes older than `stalePendingAfterMs`. */
  readonly stalePending: number;
  /** Present when the run stopped early because its signal aborted (the tenant run lock was lost). */
  readonly aborted?: true;
}

const DEFAULT_BATCH = { sign: 50, send: 20, poll: 20, recover: 10 } as const;
const DEFAULT_STALE_PENDING_MS = 15 * 60_000;
const HELD_REPORT_LIMIT = 50;

/**
 * One tenant's transmission cycle (plan 8.1): sign accepted documents, assemble lotes, send pending
 * lotes, poll due ones, recover by CDC the ones the poll gave up on. Steps are bounded by batch size and idempotent per document or lote, so
 * re-running is safe. A failure is recorded and logged (error class only) without stopping the
 * rest; the next run finds the work again. A scheduler (BullMQ, S5c) decides when to run it.
 */
export class TransmissionCycle {
  private readonly batch: Required<TransmissionCycleBatch>;
  private failures: CycleFailure[] = [];
  private signal: AbortSignal | undefined;

  constructor(private readonly deps: TransmissionCycleDeps) {
    this.batch = { ...DEFAULT_BATCH, ...deps.batch };
  }

  /**
   * Runs one cycle. If `signal` aborts (the caller lost the tenant run lock) no further unit of work
   * starts: the one in flight finishes, the report says `aborted` and the next run picks the rest up.
   */
  async run({ signal }: { signal?: AbortSignal } = {}): Promise<CycleReport> {
    this.failures = [];
    this.signal = signal;
    const signing = await this.signAccepted();
    const assembled = await this.assemble();
    const sending = await this.sendPending();
    const polled = await this.pollDue();
    const recovered = await this.recoverDue();
    const held =
      (await this.guard('sign', undefined, () =>
        this.deps.store.heldDocuments(HELD_REPORT_LIMIT),
      )) ?? [];
    const cutoff = new Date(
      this.clock().getTime() - (this.deps.stalePendingAfterMs ?? DEFAULT_STALE_PENDING_MS),
    );
    const stalePending =
      (await this.guard('send', undefined, () => this.deps.store.pendingOlderThan(cutoff))) ?? 0;
    return {
      ...signing,
      assembled,
      ...sending,
      polled,
      recovered,
      failures: this.failures,
      held,
      stalePending,
      ...(signal?.aborted ? { aborted: true as const } : {}),
    };
  }

  private async signAccepted() {
    let signed = 0;
    let signSkipped = 0;
    const ids = await this.guard('sign', undefined, () =>
      this.deps.store.acceptedDocumentIds(this.batch.sign),
    );
    for (const documentId of ids ?? []) {
      const result = await this.guard('sign', documentId, () =>
        this.deps.signer.execute({ tenantId: this.deps.tenantId, documentId }),
      );
      if (result === undefined) await this.parkIfDeterministic(documentId);
      else if (result.status === 'signed') signed += 1;
      else signSkipped += 1;
    }
    return { signed, signSkipped };
  }

  private async assemble(): Promise<number> {
    const result = await this.guard('assemble', undefined, () => this.deps.assembler.assemble());
    return result?.lotes.length ?? 0;
  }

  private async sendPending() {
    const sent: { loteId: string; status: string }[] = [];
    let sendSkipped = 0;
    const pending = await this.guard('send', undefined, () =>
      this.deps.store.pendingLotes(this.batch.send),
    );
    for (const { loteId, lote } of pending ?? []) {
      const result = await this.guard('send', loteId, async () => {
        const dId = await this.deps.store.nextRequestId();
        return this.deps.sender.execute({ loteId, dId, lote });
      });
      if (result === undefined) {
        await this.guard('send', loteId, () => this.deps.store.deferPendingLote(loteId));
      } else if (result.status === 'already-claimed') sendSkipped += 1;
      else sent.push({ loteId, status: result.status });
    }
    return { sent, sendSkipped };
  }

  private async pollDue() {
    const polled: { loteId: string; status: string }[] = [];
    const due = await this.guard('poll', undefined, () =>
      this.deps.store.dueLoteIds(this.clock(), this.batch.poll),
    );
    for (const loteId of due ?? []) {
      const result = await this.guard('poll', loteId, async () => {
        const dId = await this.deps.store.nextRequestId();
        return this.deps.poller.execute({ loteId, dId });
      });
      if (result) polled.push({ loteId, status: result.status });
    }
    return polled;
  }

  /** After polling: a lote the poll just handed to recovery waits its own 10 minutes first. */
  private async recoverDue() {
    const recovered: { loteId: string; status: string }[] = [];
    const due = await this.guard('recover', undefined, () =>
      this.deps.store.recoverableLoteIds(this.clock(), this.batch.recover),
    );
    for (const loteId of due ?? []) {
      const result = await this.guard('recover', loteId, () =>
        this.deps.recoverer.execute({ loteId }),
      );
      if (result) recovered.push({ loteId, status: result.status });
    }
    return recovered;
  }

  private clock(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async parkIfDeterministic(documentId: string): Promise<void> {
    const last = this.failures.at(-1);
    if (last?.id !== documentId || !DETERMINISTIC_SIGNING_ERRORS.has(last.error)) return;
    await this.guard('sign', documentId, () =>
      this.deps.store.holdDocument(documentId, `signing:${last.error}`),
    );
  }

  /** Runs one unit of work; a failure is recorded and logged and yields undefined. */
  private async guard<T>(
    step: CycleStep,
    id: string | undefined,
    work: () => Promise<T>,
  ): Promise<T | undefined> {
    if (this.signal?.aborted) return undefined;
    try {
      return await work();
    } catch (cause) {
      const error = cause instanceof Error ? cause.name : 'unknown error';
      this.failures.push(id === undefined ? { step, error } : { step, id, error });
      const subject = id === undefined ? '' : ` ${id}`;
      this.deps.logger?.warn(
        `TransmissionCycle ${step}${subject} failed for tenant ${this.deps.tenantId}: ${error}`,
      );
      return undefined;
    }
  }
}
