import { deflateSync, crc32 } from 'node:zlib';
import { PDFiumLibrary, type PDFiumDocument } from '@hyzyla/pdfium';
import {
  CorruptPdfError,
  EmptyPdfError,
  TooManyPagesError,
  type PdfRenderer,
  type RasterizeOptions,
} from '../../application/ports/pdf-renderer.port.js';

/** Largest rendered side in pixels: A4 at 200 dpi is 1654 x 2339, so this only stops hostile page boxes. */
export const DEFAULT_PDF_MAX_PIXEL_DIMENSION = 4096;
/** Budget for the PNG bytes of one `rasterize` call (they go to the LLM as base64 images). */
export const DEFAULT_PDF_MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

const POINTS_PER_INCH = 72;
const MIN_DPI = 36;
const MAX_DPI = 600;

export interface PdfiumPdfRendererOptions {
  /** Input size limit; keep it aligned with `RECEPTION_MAX_UPLOAD_BYTES`. Larger input is refused unparsed. */
  readonly maxInputBytes: number;
  /** Longest side of a rendered page; the scale is reduced to fit, never the page cropped. */
  readonly maxPixelDimension?: number;
  /** Total PNG bytes allowed for one `rasterize` call. */
  readonly maxOutputBytes?: number;
  /** Creates the PDFium instance (the wasm module); injectable so tests can observe its lifecycle. */
  readonly initializeLibrary?: () => Promise<PDFiumLibrary>;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes opaque RGBA pixels (alpha ignored) as an 8-bit RGB PNG with no third-party encoder. */
function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const out = y * (stride + 1);
    raw[out] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = out + 1 + x * 3;
      raw[to] = rgba[from] ?? 0;
      raw[to + 1] = rgba[from + 1] ?? 0;
      raw[to + 2] = rgba[from + 2] ?? 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: RGB
  return new Uint8Array(
    Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/**
 * PDF text and raster adapter over PDFium compiled to WebAssembly (`@hyzyla/pdfium`, ADR-0026 R5.4).
 * PDFium here has no JavaScript engine and no network access, so scripts and external references in
 * a hostile document are inert; the adapter additionally bounds input bytes, page pixels and output
 * bytes. Malformed, encrypted and page-less files all surface as typed port errors.
 */
export class PdfiumPdfRenderer implements PdfRenderer {
  private library: Promise<PDFiumLibrary> | null = null;
  private readonly maxInputBytes: number;
  private readonly maxPixelDimension: number;
  private readonly maxOutputBytes: number;
  private readonly initializeLibrary: () => Promise<PDFiumLibrary>;

  constructor(options: PdfiumPdfRendererOptions) {
    this.maxInputBytes = options.maxInputBytes;
    this.maxPixelDimension = options.maxPixelDimension ?? DEFAULT_PDF_MAX_PIXEL_DIMENSION;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PDF_MAX_OUTPUT_BYTES;
    this.initializeLibrary = options.initializeLibrary ?? (() => PDFiumLibrary.init());
  }

  async countPages(pdf: Uint8Array): Promise<number> {
    return this.withDocument(pdf, (document) => document.getPageCount());
  }

  async extractText(pdf: Uint8Array): Promise<string> {
    return this.withDocument(pdf, (document) => {
      const parts: string[] = [];
      for (let index = 0; index < document.getPageCount(); index += 1) {
        const page = document.getPage(index);
        try {
          parts.push(page.getText());
        } finally {
          page.close();
        }
      }
      return parts.join('\n').trim();
    });
  }

  async rasterize(pdf: Uint8Array, options: RasterizeOptions): Promise<readonly Uint8Array[]> {
    assertRasterizeOptions(options);
    return this.withDocument(pdf, async (document) => {
      const total = document.getPageCount();
      if (total > options.maxPages && options.overflow === 'reject') {
        throw new TooManyPagesError(total, options.maxPages);
      }
      const images: Uint8Array[] = [];
      let bytes = 0;
      for (let index = 0; index < Math.min(total, options.maxPages); index += 1) {
        const image = await this.renderPage(document, index, options.dpi);
        bytes += image.length;
        if (bytes > this.maxOutputBytes) throw new CorruptPdfError();
        images.push(image);
      }
      return images;
    });
  }

  private async renderPage(
    document: PDFiumDocument,
    index: number,
    dpi: number,
  ): Promise<Uint8Array> {
    const page = document.getPage(index);
    try {
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const longest = Math.max(originalWidth, originalHeight);
      if (!(originalWidth > 0 && originalHeight > 0 && Number.isFinite(longest))) {
        throw new CorruptPdfError();
      }
      const scale = Math.min(dpi / POINTS_PER_INCH, this.maxPixelDimension / longest);
      const rendered = await page.render({ scale, render: 'bitmap', renderFormFields: false });
      return encodePng(rendered.width, rendered.height, rendered.data);
    } catch (error) {
      throw error instanceof CorruptPdfError ? error : new CorruptPdfError();
    } finally {
      page.close();
    }
  }

  private async withDocument<T>(
    pdf: Uint8Array,
    use: (document: PDFiumDocument) => T | Promise<T>,
  ): Promise<T> {
    if (pdf.length === 0 || pdf.length > this.maxInputBytes) throw new CorruptPdfError();
    const document = await this.open(pdf);
    try {
      if (document.getPageCount() === 0) throw new EmptyPdfError();
      return await use(document);
    } catch (error) {
      if (
        error instanceof CorruptPdfError ||
        error instanceof EmptyPdfError ||
        error instanceof TooManyPagesError
      ) {
        throw error;
      }
      throw new CorruptPdfError();
    } finally {
      document.destroy();
    }
  }

  private async open(pdf: Uint8Array): Promise<PDFiumDocument> {
    const library = await this.ensureLibrary();
    try {
      return await library.loadDocument(pdf);
    } catch {
      // An unreadable document (corrupt, encrypted) says nothing about the library: keep it.
      throw new CorruptPdfError();
    }
  }

  private async ensureLibrary(): Promise<PDFiumLibrary> {
    const pending = (this.library ??= this.initializeLibrary());
    try {
      return await pending;
    } catch {
      // Only a failed init is cleared (there is no instance to destroy), so the next call retries.
      if (this.library === pending) this.library = null;
      throw new CorruptPdfError();
    }
  }
}

function assertRasterizeOptions({ maxPages, dpi }: RasterizeOptions): void {
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError('maxPages must be a positive integer');
  }
  if (!Number.isInteger(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
    throw new RangeError(
      `dpi must be an integer between ${String(MIN_DPI)} and ${String(MAX_DPI)}`,
    );
  }
}
