import type { SignDocument } from '../../emission/application/sign-document.js';
import type { Lote } from '../domain/lote-builder.js';
import type { LoteAssembler } from './assemble-lotes.js';
import type { PollLoteResult } from './poll-lote-result.js';
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
  /** Reserves the next SIFEN request id (`dId`) for the tenant and environment. */
  nextRequestId(): Promise<bigint>;
}

export interface TransmissionCycleBatch {
  readonly sign?: number;
  readonly send?: number;
  readonly poll?: number;
}

export interface TransmissionCycleDeps {
  readonly tenantId: string;
  readonly store: TransmissionCycleStore;
  readonly signer: Pick<SignDocument, 'execute'>;
  readonly assembler: Pick<LoteAssembler, 'assemble'>;
  readonly sender: Pick<SendLote, 'execute'>;
  readonly poller: Pick<PollLoteResult, 'execute'>;
  readonly batch?: TransmissionCycleBatch;
  readonly now?: () => Date;
  readonly logger?: { warn(message: string): void };
}

export type CycleStep = 'sign' | 'assemble' | 'send' | 'poll';

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
  readonly failures: readonly CycleFailure[];
}

const DEFAULT_BATCH = { sign: 50, send: 20, poll: 20 } as const;

/**
 * One tenant's transmission cycle (plan 8.1): sign accepted documents, assemble lotes, send pending
 * lotes, poll due ones. Steps are bounded by batch size and idempotent per document or lote, so
 * re-running is safe. A failure is recorded and logged (error class only) without stopping the
 * rest; the next run finds the work again. A scheduler (BullMQ, S5c) decides when to run it.
 */
export class TransmissionCycle {
  private readonly batch: Required<TransmissionCycleBatch>;
  private failures: CycleFailure[] = [];

  constructor(private readonly deps: TransmissionCycleDeps) {
    this.batch = { ...DEFAULT_BATCH, ...deps.batch };
  }

  async run(): Promise<CycleReport> {
    this.failures = [];
    const signing = await this.signAccepted();
    const assembled = await this.assemble();
    const sending = await this.sendPending();
    const polled = await this.pollDue();
    return { ...signing, assembled, ...sending, polled, failures: this.failures };
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
      if (result?.status === 'signed') signed += 1;
      else if (result) signSkipped += 1;
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
      if (result?.status === 'already-claimed') sendSkipped += 1;
      else if (result) sent.push({ loteId, status: result.status });
    }
    return { sent, sendSkipped };
  }

  private async pollDue() {
    const polled: { loteId: string; status: string }[] = [];
    const due = await this.guard('poll', undefined, () =>
      this.deps.store.dueLoteIds((this.deps.now ?? (() => new Date()))(), this.batch.poll),
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

  /** Runs one unit of work; a failure is recorded and logged and yields undefined. */
  private async guard<T>(
    step: CycleStep,
    id: string | undefined,
    work: () => Promise<T>,
  ): Promise<T | undefined> {
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
