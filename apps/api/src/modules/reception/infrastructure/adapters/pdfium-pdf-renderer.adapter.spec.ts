import { describe, expect, it } from 'vitest';
import {
  CorruptPdfError,
  EmptyPdfError,
  TooManyPagesError,
} from '../../application/ports/pdf-renderer.port.js';
import { PdfiumPdfRenderer } from './pdfium-pdf-renderer.adapter.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PdfBuildOptions {
  /** Text of each page; `null` makes a page without a text layer. */
  readonly pages: readonly (string | null)[];
  readonly mediaBox?: readonly [number, number];
  /** Extra entries for the catalog, e.g. an `/OpenAction`. */
  readonly catalogExtras?: string;
}

/** Builds a tiny valid PDF with a correct xref table; anonymous content only. */
function buildPdf({ pages, mediaBox = [612, 792], catalogExtras = '' }: PdfBuildOptions): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R ${catalogExtras} >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(pages.length)} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const pageId = 4 + i * 2;
    const stream = text === null ? '' : `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(mediaBox[0])} ${String(mediaBox[1])}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageId + 1)} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
  });
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${String(id)} 0 obj\n${objects[id] ?? ''}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(png);
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

const renderer = new PdfiumPdfRenderer({ maxInputBytes: 1024 * 1024 });
const options = { maxPages: 5, dpi: 200, overflow: 'truncate' } as const;

describe('PdfiumPdfRenderer.countPages', () => {
  it('counts the pages', async () => {
    const pdf = buildPdf({ pages: ['Test Invoice 001', 'Test Invoice 002', 'Test Invoice 003'] });
    await expect(renderer.countPages(pdf)).resolves.toBe(3);
  });

  it.each([
    ['garbage bytes', Buffer.from('this is not a pdf at all')],
    ['empty input', Buffer.alloc(0)],
    ['a truncated header', Buffer.from('%PDF-1.4\n1 0 obj')],
  ])('rejects %s as corrupt', async (_name, bytes) => {
    await expect(renderer.countPages(bytes)).rejects.toBeInstanceOf(CorruptPdfError);
  });

  it('rejects input above the byte limit without parsing it', async () => {
    const small = new PdfiumPdfRenderer({ maxInputBytes: 100 });
    const pdf = buildPdf({ pages: ['Test Invoice 001'] });
    expect(pdf.length).toBeGreaterThan(100);
    await expect(small.countPages(pdf)).rejects.toBeInstanceOf(CorruptPdfError);
  });

  it('reports a PDF without pages as empty', async () => {
    await expect(renderer.countPages(buildPdf({ pages: [] }))).rejects.toBeInstanceOf(
      EmptyPdfError,
    );
  });
});

describe('PdfiumPdfRenderer.extractText', () => {
  it('joins the text layer of every page in order and trims it', async () => {
    const pdf = buildPdf({ pages: ['Test Invoice 001', 'Test Invoice 002'] });
    const text = await renderer.extractText(pdf);
    expect(text).toMatch(/^Test Invoice 001\s+Test Invoice 002$/);
  });

  it('returns an empty string for a PDF without a text layer', async () => {
    await expect(renderer.extractText(buildPdf({ pages: [null, null] }))).resolves.toBe('');
  });

  it('rejects garbage as corrupt and a page-less PDF as empty', async () => {
    await expect(renderer.extractText(Buffer.from('nope'))).rejects.toBeInstanceOf(CorruptPdfError);
    await expect(renderer.extractText(buildPdf({ pages: [] }))).rejects.toBeInstanceOf(
      EmptyPdfError,
    );
  });
});

describe('PdfiumPdfRenderer.rasterize', () => {
  it('renders one PNG per page at the requested dpi', async () => {
    const pdf = buildPdf({ pages: ['Test Invoice 001', 'Test Invoice 002'] });
    const images = await renderer.rasterize(pdf, options);
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(Buffer.from(image).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      // 612 x 792 points at 200 dpi.
      expect(pngSize(image)).toEqual({ width: 1700, height: 2200 });
    }
  });

  it('draws content: a page with text is not a blank page', async () => {
    const [blank] = await renderer.rasterize(buildPdf({ pages: [null] }), options);
    const [written] = await renderer.rasterize(buildPdf({ pages: ['Test Invoice 001'] }), options);
    expect(Buffer.from(written).equals(Buffer.from(blank))).toBe(false);
  });

  it('truncates to the first maxPages pages', async () => {
    const pdf = buildPdf({ pages: ['a', 'b', 'c', 'd'] });
    const images = await renderer.rasterize(pdf, { ...options, maxPages: 2, dpi: 72 });
    expect(images).toHaveLength(2);
  });

  it('rejects an overflow when asked to', async () => {
    const pdf = buildPdf({ pages: ['a', 'b', 'c'] });
    const error = await renderer
      .rasterize(pdf, { ...options, maxPages: 2, overflow: 'reject' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TooManyPagesError);
    expect(error).toMatchObject({ pageCount: 3, maxPages: 2 });
  });

  it('accepts exactly maxPages pages with overflow reject', async () => {
    const pdf = buildPdf({ pages: ['a', 'b'] });
    const images = await renderer.rasterize(pdf, {
      ...options,
      maxPages: 2,
      dpi: 72,
      overflow: 'reject',
    });
    expect(images).toHaveLength(2);
  });

  it('maps corrupt and page-less PDFs to typed errors', async () => {
    await expect(renderer.rasterize(Buffer.from('garbage'), options)).rejects.toBeInstanceOf(
      CorruptPdfError,
    );
    await expect(renderer.rasterize(buildPdf({ pages: [] }), options)).rejects.toBeInstanceOf(
      EmptyPdfError,
    );
  });

  it('caps the pixel size of a hostile huge page instead of allocating it', async () => {
    const capped = new PdfiumPdfRenderer({ maxInputBytes: 1024 * 1024, maxPixelDimension: 1000 });
    const pdf = buildPdf({ pages: ['Test Invoice 001'], mediaBox: [14400, 7200] });
    const [image] = await capped.rasterize(pdf, options);
    const { width, height } = pngSize(image);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1000);
    expect(width / height).toBeCloseTo(2, 1);
  });

  it('stops when the rendered output exceeds the byte budget', async () => {
    const tight = new PdfiumPdfRenderer({ maxInputBytes: 1024 * 1024, maxOutputBytes: 200 });
    const pdf = buildPdf({ pages: ['Test Invoice 001'] });
    await expect(tight.rasterize(pdf, options)).rejects.toBeInstanceOf(CorruptPdfError);
  });

  it.each([
    { ...options, dpi: 0 },
    { ...options, dpi: 5000 },
    { ...options, dpi: 1.5 },
    { ...options, maxPages: 0 },
    { ...options, maxPages: 1.5 },
  ])('rejects invalid options %j', async (invalid) => {
    const pdf = buildPdf({ pages: ['a'] });
    await expect(renderer.rasterize(pdf, invalid)).rejects.toBeInstanceOf(RangeError);
  });

  it('does not execute or fetch anything declared by the document', async () => {
    const pdf = buildPdf({
      pages: ['Test Invoice 001'],
      catalogExtras:
        '/OpenAction << /S /JavaScript /JS (this.getURL\\("http://127.0.0.1:1/x"\\);) >>',
    });
    await expect(renderer.countPages(pdf)).resolves.toBe(1);
    await expect(renderer.rasterize(pdf, { ...options, dpi: 72 })).resolves.toHaveLength(1);
  });

  it('serves concurrent calls independently', async () => {
    const one = buildPdf({ pages: ['Test Invoice 001'] });
    const two = buildPdf({ pages: ['x', 'y'] });
    const [a, b] = await Promise.all([renderer.countPages(one), renderer.countPages(two)]);
    expect([a, b]).toEqual([1, 2]);
  });
});
