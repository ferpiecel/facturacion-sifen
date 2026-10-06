import { parseCdc } from '../../emission/domain/cdc.js';
import { LoteBuilder, type Lote, type LoteBuilderDeps } from '../domain/lote-builder.js';

export interface ReadyDocument {
  readonly documentId: string;
  readonly cdc: string;
  /** Signed DE XML. */
  readonly xml: string;
  /** Queued again by the recovery after SIFEN kept answering 0420 (`resent_at`): it must be verified before it is sent. */
  readonly resent?: boolean;
  /** When it was queued again; the pre-send check gives up on it a while after. */
  readonly resentAt?: Date;
}

/**
 * What the last look at SIFEN says about a resent document: `send` (still 0420), `approved` (SIFEN
 * now holds it, so it was settled instead) or `wait` (could not tell: never a reason to send).
 */
export type ResendVerdict = 'send' | 'approved' | 'wait';

export interface ResendCheck {
  verify(document: ReadyDocument): Promise<ResendVerdict>;
}

export interface LoteAssemblyStore {
  /** Documents ready for transmission (`signed` or `queued`), oldest first. */
  readyDocuments(): Promise<readonly ReadyDocument[]>;
  /**
   * Postpones a resent document (`next_transmission_at`): the pre-send check could not verify it and
   * asks again later, not every run. Only a queued, resent, unheld document is touched.
   */
  deferDocument(documentId: string, until: Date): Promise<void>;
  /** Holds a resent document for an operator when the pre-send check never resolves (same guard as `deferDocument`). */
  holdResend(documentId: string, reason: string): Promise<void>;
  /** Those of `cdcs` that belong to a lote still in process. */
  cdcsInProcess(cdcs: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * Atomically creates a `pending` lote with these documents and queues them. Returns the lote id,
   * or null (nothing written) when any document stopped being ready.
   */
  createLote(input: {
    readonly documentType: number;
    readonly documentIds: readonly string[];
  }): Promise<string | null>;
}

export interface LoteAssemblerDeps {
  readonly store: LoteAssemblyStore;
  readonly measureMessage: LoteBuilderDeps['measureMessage'];
  readonly logger?: { warn(message: string): void };
  /** Verifies resent documents right before they join a lote; without it they are never sent. */
  readonly resendCheck?: ResendCheck;
  /** Most resent documents verified per run (default 20); the rest wait for the next run. */
  readonly maxResendChecks?: number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_RESEND_CHECKS = 20;
/** An unverifiable resent document is asked again after this, as with every other 10-minute query. */
const RESEND_RETRY_MS = 10 * 60 * 1000;
/**
 * ...and held after this long without a clean answer: 6 hours is 36 paced tries, far longer than a
 * passing SIFEN outage, so what remains is a persistent problem for a person to look at.
 */
const RESEND_GIVE_UP_MS = 6 * 60 * 60 * 1000;
export const RESEND_PRECHECK_UNRESOLVED_HOLD = 'resend:precheck-unresolved';

export interface AssembledLote {
  readonly loteId: string;
  readonly documentType: string;
  readonly cdcs: readonly string[];
}

export interface SkippedDocument {
  readonly cdc: string;
  readonly reason: string;
}

export interface ConflictedDocument {
  readonly cdc: string;
  /** Sanitized, capped description when the create threw; absent when a document was just no longer ready. */
  readonly error?: string;
}

export interface AssembleLotesResult {
  readonly lotes: readonly AssembledLote[];
  readonly skipped: readonly SkippedDocument[];
  /** Documents of lotes that were not created: one stopped being ready, or the create failed. */
  readonly conflicted: readonly ConflictedDocument[];
}

/**
 * Turns ready documents into `pending` lotes (ADR-0007, plan 8.1): one RUC and one type per lote,
 * at most 50 documents and 1000 KB, and no CDC that another lote in process already carries.
 * Each lote is persisted atomically with the queuing of its documents; a lote whose documents
 * stopped being ready is reported as conflicted and the rest still go ahead.
 */
export class LoteAssembler {
  constructor(private readonly deps: LoteAssemblerDeps) {}

  async assemble({ signal }: { signal?: AbortSignal } = {}): Promise<AssembleLotesResult> {
    const all = await this.deps.store.readyDocuments();
    if (all.length === 0) return { lotes: [], skipped: [], conflicted: [] };

    const skipped: SkippedDocument[] = [];
    const cleared = await this.clearResent(all, skipped, signal);
    const ready = cleared.filter((document) => {
      if (isValidCdc(document.cdc)) return true;
      skipped.push({ cdc: document.cdc, reason: 'invalid-cdc' });
      return false;
    });
    if (ready.length === 0) return { lotes: [], skipped, conflicted: [] };
    const inProcess = await this.deps.store.cdcsInProcess(ready.map((d) => d.cdc));

    const planned: Planned[] = [];
    for (const group of groupByRucAndType(ready).values()) {
      planned.push(...this.fill(group, inProcess, skipped));
    }

    const lotes: AssembledLote[] = [];
    const conflicted: ConflictedDocument[] = [];
    for (const { lote, ids } of planned) {
      const cdcs = lote.documents.map((d) => d.cdc);
      let loteId: string | null;
      let error: string | undefined;
      try {
        loteId = await this.deps.store.createLote({
          documentType: Number(lote.documentType),
          documentIds: ids,
        });
      } catch (cause) {
        // Nothing was committed for this lote; its documents stay ready for the next run.
        loteId = null;
        error = describeError(cause);
        this.deps.logger?.warn(
          `LoteAssembler: createLote failed for ${String(cdcs.length)} document(s): ${error}`,
        );
      }
      if (loteId === null)
        conflicted.push(...cdcs.map((cdc) => (error ? { cdc, error } : { cdc })));
      else lotes.push({ loteId, documentType: lote.documentType, cdcs });
    }
    return { lotes, skipped, conflicted };
  }

  /**
   * A resent document joins a lote only if SIFEN still answers 0420 for its CDC at this moment: the
   * only way a resend could duplicate a CDC is SIFEN approving it after the recovery's last 0420.
   */
  private async clearResent(
    documents: readonly ReadyDocument[],
    skipped: SkippedDocument[],
    signal: AbortSignal | undefined,
  ): Promise<ReadyDocument[]> {
    const cap = this.deps.maxResendChecks ?? DEFAULT_MAX_RESEND_CHECKS;
    let checks = 0;
    const kept: ReadyDocument[] = [];
    for (const document of documents) {
      if (!document.resent) {
        kept.push(document);
        continue;
      }
      if (signal?.aborted) {
        // The run lost its lock: no query starts, and nothing is written for this document.
        skipped.push({ cdc: document.cdc, reason: 'resend-aborted' });
        continue;
      }
      let verdict: ResendVerdict = 'wait';
      let asked = false;
      if (this.deps.resendCheck && checks < cap) {
        checks += 1;
        asked = true;
        try {
          verdict = await this.deps.resendCheck.verify(document);
        } catch {
          verdict = 'wait';
        }
      }
      if (verdict === 'send') kept.push(document);
      else if (verdict === 'approved') {
        skipped.push({ cdc: document.cdc, reason: 'resend-already-approved' });
      } else {
        skipped.push({
          cdc: document.cdc,
          reason: (await this.wait(document, asked)) ? 'resend-held' : 'resend-unverified',
        });
      }
    }
    return kept;
  }

  /** Paces a document the check could not resolve, or holds it after 6 hours. True when it was held. */
  private async wait(document: ReadyDocument, asked: boolean): Promise<boolean> {
    if (!asked) return false; // over the per-run cap: untouched, it is asked on a later run
    const now = (this.deps.now ?? (() => new Date()))();
    try {
      if (document.resentAt && now.getTime() - document.resentAt.getTime() >= RESEND_GIVE_UP_MS) {
        await this.deps.store.holdResend(document.documentId, RESEND_PRECHECK_UNRESOLVED_HOLD);
        this.deps.logger?.warn(
          `LoteAssembler: document ${document.documentId} held as ${RESEND_PRECHECK_UNRESOLVED_HOLD}: SIFEN could not be asked about its CDC for 6 hours`,
        );
        return true;
      }
      await this.deps.store.deferDocument(
        document.documentId,
        new Date(now.getTime() + RESEND_RETRY_MS),
      );
    } catch {
      // The document stays queued and is asked again on the next run.
    }
    return false;
  }

  private fill(
    group: readonly ReadyDocument[],
    inProcess: ReadonlySet<string>,
    skipped: SkippedDocument[],
  ): Planned[] {
    const newBuilder = () =>
      new LoteBuilder({
        isInProcess: (cdc) => inProcess.has(cdc),
        measureMessage: this.deps.measureMessage,
      });
    const planned: Planned[] = [];
    let builder = newBuilder();
    let ids: string[] = [];
    const flush = () => {
      if (builder.size > 0) planned.push({ lote: builder.build(), ids });
      builder = newBuilder();
      ids = [];
    };

    for (const document of group) {
      let result = builder.add(document);
      if (
        !result.accepted &&
        (result.reason === 'lote-full' || result.reason === 'size-exceeded')
      ) {
        const wasEmpty = builder.size === 0;
        flush();
        if (!wasEmpty) result = builder.add(document);
      }
      if (result.accepted) ids.push(document.documentId);
      else skipped.push({ cdc: document.cdc, reason: result.reason });
    }
    flush();
    return planned;
  }
}

interface Planned {
  readonly lote: Lote;
  readonly ids: readonly string[];
}

const MAX_ERROR_LENGTH = 200;

/** Error class and message on one line, capped: enough to diagnose, bounded to store or log. */
function describeError(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : 'Error';
  const message = cause instanceof Error ? cause.message : String(cause);
  return `${name}: ${message}`.replace(/\s+/g, ' ').slice(0, MAX_ERROR_LENGTH);
}

function isValidCdc(cdc: string): boolean {
  try {
    parseCdc(cdc);
    return true;
  } catch {
    return false;
  }
}

function groupByRucAndType(documents: readonly ReadyDocument[]): Map<string, ReadyDocument[]> {
  const groups = new Map<string, ReadyDocument[]>();
  for (const document of documents) {
    const { rucBase, documentType } = parseCdc(document.cdc);
    const key = `${rucBase}:${documentType}`;
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }
  return groups;
}
