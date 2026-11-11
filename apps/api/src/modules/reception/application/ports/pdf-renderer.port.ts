/** Bytes are not a readable PDF (corrupt, encrypted, not a PDF). */
export class CorruptPdfError extends Error {
  constructor() {
    super('the PDF is corrupt or unreadable');
    this.name = 'CorruptPdfError';
  }
}

/** A valid PDF without pages. */
export class EmptyPdfError extends Error {
  constructor() {
    super('the PDF has no pages');
    this.name = 'EmptyPdfError';
  }
}

export class TooManyPagesError extends Error {
  constructor(
    readonly pageCount: number,
    readonly maxPages: number,
  ) {
    super(`the PDF has ${String(pageCount)} pages, above the limit of ${String(maxPages)}`);
    this.name = 'TooManyPagesError';
  }
}

export interface RasterizeOptions {
  /** Maximum number of pages to render. */
  readonly maxPages: number;
  readonly dpi: number;
  /**
   * What to do when the PDF has more than `maxPages`: render the first `maxPages` (`truncate`, the
   * behavior of the original system) or throw {@link TooManyPagesError} (`reject`).
   */
  readonly overflow: 'truncate' | 'reject';
}

export interface PdfRenderer {
  /** Throws {@link CorruptPdfError}. */
  countPages(pdf: Uint8Array): Promise<number>;
  /** Text layer of every page joined in order; empty string for a scanned PDF. */
  extractText(pdf: Uint8Array): Promise<string>;
  /** PNG bytes per page, in order. Throws {@link CorruptPdfError}, {@link EmptyPdfError}, {@link TooManyPagesError}. */
  rasterize(pdf: Uint8Array, options: RasterizeOptions): Promise<readonly Uint8Array[]>;
}
