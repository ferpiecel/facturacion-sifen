import type { LoteBuilderDeps } from '../domain/lote-builder.js';

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

export class LoteAssembler {
  constructor(private readonly deps: LoteAssemblerDeps) {}

  assemble(): Promise<AssembleLotesResult> {
    return Promise.reject(new Error('not implemented'));
  }
}
