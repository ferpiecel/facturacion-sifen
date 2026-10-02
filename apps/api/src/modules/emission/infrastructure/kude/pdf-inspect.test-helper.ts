import { inflateSync } from 'node:zlib';
import jsQRModule from 'jsqr';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// jsqr's typings say `export default`, its CJS build exports the function itself: accept both.
type QrReader = (data: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const reader = jsQRModule as unknown as QrReader | { default: QrReader };
const jsQR: QrReader = typeof reader === 'function' ? reader : reader.default;

/** Test support: reads back what a rendered PDF shows, through pdfjs (font ToUnicode aware). */
export interface TextItem {
  str: string;
  x: number;
  /** Baseline, PDF coordinates (grows upwards). */
  y: number;
  size: number;
  width: number;
  page: number;
}

export async function textItems(pdf: Uint8Array): Promise<TextItem[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
  const items: TextItem[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const item of content.items) {
      if (!('str' in item) || item.str === '') continue;
      items.push({
        str: item.str,
        x: item.transform[4] as number,
        y: item.transform[5] as number,
        size: item.height,
        width: item.width,
        page,
      });
    }
  }
  return items;
}

/** Every drawn string, one per line, in painting order. */
export async function pdfText(pdf: Uint8Array): Promise<string> {
  return (await textItems(pdf)).map((item) => item.str).join('\n');
}

/** Pairs of strings drawn on top of each other (same page, intersecting boxes). */
export function overlaps(items: TextItem[]): [string, string][] {
  const found: [string, string][] = [];
  items.forEach((a, i) => {
    for (const b of items.slice(i + 1)) {
      const sameBand = a.page === b.page && Math.abs(a.y - b.y) < 0.6 * Math.max(a.size, b.size);
      const xOverlap = a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5;
      if (sameBand && xOverlap) found.push([a.str, b.str]);
    }
  });
  return found;
}

/** Width and height in points of every image painted on the pages (content-stream matrices). */
export function imageSizes(pdf: Uint8Array): { w: number; h: number }[] {
  const raw = Buffer.from(pdf).toString('latin1');
  return [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap((m) => {
    const bytes = Buffer.from(m[1], 'latin1');
    let content: string;
    try {
      content = inflateSync(bytes).toString('latin1');
    } catch {
      content = bytes.toString('latin1');
    }
    return [...content.matchAll(/(-?[\d.]+) 0 0 (-?[\d.]+) -?[\d.]+ -?[\d.]+ cm\s+\/I\d+ Do/g)].map(
      (c) => ({ w: Math.abs(Number(c[1])), h: Math.abs(Number(c[2])) }),
    );
  });
}

export interface QrImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** The first image of page 1 (RGBA), null when there is none. */
export async function firstImage(pdf: Uint8Array): Promise<QrImage | null> {
  const page = await (await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise).getPage(1);
  const ops = await page.getOperatorList();
  const at = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
  const name = (ops.argsArray[at] as string[] | undefined)?.[0];
  if (name === undefined) return null;
  return new Promise<QrImage>((resolve) => {
    page.objs.get(name, resolve);
  });
}

/** Decodes the first image of page 1 as a QR code; null when none is readable. */
export async function decodeQr(pdf: Uint8Array): Promise<string | null> {
  const image = await firstImage(pdf);
  return image ? (jsQR(image.data, image.width, image.height)?.data ?? null) : null;
}

/** Share of the image width that is blank before the first dark pixel (quiet zone per side). */
export function quietZoneRatio(image: QrImage): number {
  let first = image.width;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < first; x += 1) {
      if ((image.data[(y * image.width + x) * 4] ?? 255) < 128) first = x;
    }
  }
  return first / image.width;
}
