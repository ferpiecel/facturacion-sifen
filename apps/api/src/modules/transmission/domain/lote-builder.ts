import { parseCdc } from '../../emission/domain/cdc.js';

/** DNIT best-practices guide (2024): at most 50 DEs per lote. */
export const MAX_LOTE_DOCUMENTS = 50;

/**
 * Message limit for `siRecepLoteDE`: zip + Base64 + envelope, 1000 KB (guide 2024;
 * the Manual Técnico says 10,000 KB and the stricter one is taken). 1 KB is read
 * as 1000 bytes, the more restrictive reading.
 */
export const MAX_LOTE_MESSAGE_BYTES = 1_000_000;

export interface LoteDocument {
  /** 44-digit CDC; fixes the lote's RUC and document type. */
  readonly cdc: string;
  /** Signed DE XML. */
  readonly xml: string;
}

export interface LoteBuilderDeps {
  /** True when the CDC belongs to another lote that is still being processed. */
  readonly isInProcess: (cdc: string) => boolean;
  /** Size in bytes of the full message (zip + Base64 + envelope) for these XMLs. */
  readonly measureMessage: (xmls: readonly string[]) => number;
}

export type LoteRejection =
  | 'ruc-mismatch'
  | 'type-mismatch'
  | 'lote-full'
  | 'duplicate-cdc'
  | 'cdc-in-process'
  | 'size-exceeded';

export type AddResult =
  { readonly accepted: true } | { readonly accepted: false; readonly reason: LoteRejection };

export interface Lote {
  readonly rucBase: string;
  readonly rucDv: number;
  readonly documentType: string;
  readonly documents: readonly LoteDocument[];
}

export class EmptyLoteError extends Error {
  constructor() {
    super('A lote needs at least one document');
    this.name = 'EmptyLoteError';
  }
}

/** Accumulates DEs into a lote that SIFEN will not reject (and block the RUC for). */
export class LoteBuilder {
  private readonly documents: LoteDocument[] = [];
  private readonly cdcs = new Set<string>();
  private identity: { rucBase: string; rucDv: number; documentType: string } | undefined;

  constructor(private readonly deps: LoteBuilderDeps) {}

  get size(): number {
    return this.documents.length;
  }

  /** Adds the document or reports why not; a rejection leaves the lote untouched. @throws InvalidCdcError */
  add(document: LoteDocument): AddResult {
    const { rucBase, rucDv, documentType } = parseCdc(document.cdc);
    const reason = this.rejection(document, rucBase, documentType);
    if (reason !== undefined) return { accepted: false, reason };

    this.identity ??= { rucBase, rucDv, documentType };
    this.documents.push(document);
    this.cdcs.add(document.cdc);
    return { accepted: true };
  }

  /** @throws EmptyLoteError */
  build(): Lote {
    if (this.identity === undefined) throw new EmptyLoteError();
    return { ...this.identity, documents: [...this.documents] };
  }

  private rejection(
    document: LoteDocument,
    rucBase: string,
    documentType: string,
  ): LoteRejection | undefined {
    if (this.identity !== undefined) {
      if (this.identity.rucBase !== rucBase) return 'ruc-mismatch';
      if (this.identity.documentType !== documentType) return 'type-mismatch';
    }
    if (this.documents.length >= MAX_LOTE_DOCUMENTS) return 'lote-full';
    if (this.cdcs.has(document.cdc)) return 'duplicate-cdc';
    if (this.deps.isInProcess(document.cdc)) return 'cdc-in-process';
    const xmls = [...this.documents.map((d) => d.xml), document.xml];
    if (this.deps.measureMessage(xmls) > MAX_LOTE_MESSAGE_BYTES) return 'size-exceeded';
    return undefined;
  }
}
