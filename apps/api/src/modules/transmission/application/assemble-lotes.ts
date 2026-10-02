import { parseCdc } from '../../emission/domain/cdc.js';
import { LoteBuilder, type Lote, type LoteBuilderDeps } from '../domain/lote-builder.js';

export interface ReadyDocument {
  readonly documentId: string;
  readonly cdc: string;
  /** Signed DE XML. */
  readonly xml: string;
}

export interface LoteAssemblyStore {
  /** Documents ready for transmission (`signed` or `queued`), oldest first. */
  readyDocuments(): Promise<readonly ReadyDocument[]>;
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
}

export interface AssembledLote {
  readonly loteId: string;
  readonly documentType: string;
  readonly cdcs: readonly string[];
}

export interface SkippedDocument {
  readonly cdc: string;
  readonly reason: string;
}

export interface AssembleLotesResult {
  readonly lotes: readonly AssembledLote[];
  readonly skipped: readonly SkippedDocument[];
  /** Documents of lotes that were not created because one stopped being ready. */
  readonly conflicted: readonly string[];
}

/**
 * Turns ready documents into `pending` lotes (ADR-0007, plan 8.1): one RUC and one type per lote,
 * at most 50 documents and 1000 KB, and no CDC that another lote in process already carries.
 * Each lote is persisted atomically with the queuing of its documents; a lote whose documents
 * stopped being ready is reported as conflicted and the rest still go ahead.
 */
export class LoteAssembler {
  constructor(private readonly deps: LoteAssemblerDeps) {}

  async assemble(): Promise<AssembleLotesResult> {
    const ready = await this.deps.store.readyDocuments();
    if (ready.length === 0) return { lotes: [], skipped: [], conflicted: [] };
    const inProcess = await this.deps.store.cdcsInProcess(ready.map((d) => d.cdc));

    const skipped: SkippedDocument[] = [];
    const planned: Planned[] = [];
    for (const group of groupByRucAndType(ready).values()) {
      planned.push(...this.fill(group, inProcess, skipped));
    }

    const lotes: AssembledLote[] = [];
    const conflicted: string[] = [];
    for (const { lote, ids } of planned) {
      const cdcs = lote.documents.map((d) => d.cdc);
      const loteId = await this.deps.store.createLote({
        documentType: Number(lote.documentType),
        documentIds: ids,
      });
      if (loteId === null) conflicted.push(...cdcs);
      else lotes.push({ loteId, documentType: lote.documentType, cdcs });
    }
    return { lotes, skipped, conflicted };
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

function groupByRucAndType(documents: readonly ReadyDocument[]): Map<string, ReadyDocument[]> {
  const groups = new Map<string, ReadyDocument[]>();
  for (const document of documents) {
    const { rucBase, documentType } = parseCdc(document.cdc);
    const key = `${rucBase}:${documentType}`;
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }
  return groups;
}
