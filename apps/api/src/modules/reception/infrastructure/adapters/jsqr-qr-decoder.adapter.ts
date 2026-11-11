import jpeg from 'jpeg-js';
import jsQRModule from 'jsqr';
import { PNG } from 'pngjs';
import type { QrDecoder } from '../../application/ports/qr-decoder.port.js';
import { extractCdc } from '../../domain/cdc-reference.js';

// jsqr's typings say `export default`, its CJS build exports the function itself: accept both.
type QrReader = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' },
) => { data: string } | null;
const reader = jsQRModule as unknown as QrReader | { default: QrReader };
const jsQR: QrReader = typeof reader === 'function' ? reader : reader.default;

/** Refuses images above this many pixels (judged from the header, before decoding). */
export const DEFAULT_QR_MAX_PIXELS = 40_000_000;
/** Longest side the scanner works at; larger photos are box-averaged down by whole factors. */
export const QR_SCAN_TARGET_SIDE = 2048;
/** Second, coarser pass for large photos whose QR is blurred at the first scale. */
const QR_SCAN_COARSE_SIDE = 1024;

export interface JsqrQrDecoderOptions {
  /** Input size limit; keep it aligned with `RECEPTION_MAX_UPLOAD_BYTES`. Larger input is refused unparsed. */
  readonly maxInputBytes: number;
  /** Pixel budget (width x height) taken from the image header. */
  readonly maxPixels?: number;
}

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

interface Raster extends Dimensions {
  /** Opaque RGBA, 4 bytes per pixel. */
  readonly data: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) * 0x1000000 +
    (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))
  );
}

function readU16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function pngDimensions(bytes: Uint8Array): Dimensions | null {
  const isIhdr = bytes.length >= 24 && readU32(bytes, 8) === 13 && bytes[12] === 0x49;
  if (!isIhdr || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  return { width: readU32(bytes, 16), height: readU32(bytes, 20) };
}

/** Walks the JPEG marker segments up to the first start-of-frame header. */
function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    const isStandalone = marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
    if (isStandalone) {
      at += 2;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return at + 9 <= bytes.length
        ? { height: readU16(bytes, at + 5), width: readU16(bytes, at + 7) }
        : null;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan before any frame
    at += 2 + readU16(bytes, at + 2);
  }
  return null;
}

/** Averages `factor` x `factor` blocks; RGBA in and out. */
function boxDownscale(source: Raster, factor: number): Raster {
  if (factor <= 1) return source;
  const width = Math.max(1, Math.floor(source.width / factor));
  const height = Math.max(1, Math.floor(source.height / factor));
  const data = new Uint8Array(width * height * 4);
  const area = factor * factor;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sums = [0, 0, 0];
      for (let dy = 0; dy < factor; dy += 1) {
        const row = ((y * factor + dy) * source.width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx += 1) {
          const at = row + dx * 4;
          sums[0] = (sums[0] ?? 0) + (source.data[at] ?? 0);
          sums[1] = (sums[1] ?? 0) + (source.data[at + 1] ?? 0);
          sums[2] = (sums[2] ?? 0) + (source.data[at + 2] ?? 0);
        }
      }
      const to = (y * width + x) * 4;
      data[to] = Math.round((sums[0] ?? 0) / area);
      data[to + 1] = Math.round((sums[1] ?? 0) / area);
      data[to + 2] = Math.round((sums[2] ?? 0) / area);
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Flattens transparency onto white so a transparent background does not read as black. */
function flattenOnWhite(data: Uint8Array): void {
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3] ?? 255;
    if (alpha === 255) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = data[at + channel] ?? 0;
      data[at + channel] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    }
    data[at + 3] = 255;
  }
}

/**
 * QR decoder over `jsqr` (pure JavaScript) with `pngjs` and `jpeg-js` as pixel decoders, so no
 * native binary is needed (ADR-0026, Adenda R5.5). Supports PNG and JPEG; any other format, a
 * corrupt file or an oversized one yields `null`. Input bytes and header-declared pixels are
 * checked before any decoding, and the scan runs on at most two reduced copies of the image, so
 * the work is bounded. The CDC is extracted with the domain `extractCdc`; its check digit is left
 * to the use case, like for every other CDC source.
 */
export class JsqrQrDecoder implements QrDecoder {
  private readonly maxInputBytes: number;
  private readonly maxPixels: number;

  constructor(options: JsqrQrDecoderOptions) {
    this.maxInputBytes = options.maxInputBytes;
    this.maxPixels = options.maxPixels ?? DEFAULT_QR_MAX_PIXELS;
  }

  decodeCdc(image: Uint8Array): Promise<string | null> {
    try {
      return Promise.resolve(this.scan(image));
    } catch {
      return Promise.resolve(null); // best-effort hint: never fail the upload over a photo
    }
  }

  private scan(image: Uint8Array): string | null {
    if (image.length === 0 || image.length > this.maxInputBytes) return null;
    const raster = this.decodeRaster(image);
    if (raster === null) return null;
    const longest = Math.max(raster.width, raster.height);
    const factors = new Set([
      Math.max(1, Math.ceil(longest / QR_SCAN_TARGET_SIDE)),
      Math.max(1, Math.ceil(longest / QR_SCAN_COARSE_SIDE)),
    ]);
    for (const factor of factors) {
      const scaled = boxDownscale(raster, factor);
      const code = jsQR(new Uint8ClampedArray(scaled.data), scaled.width, scaled.height, {
        inversionAttempts: 'attemptBoth',
      });
      const cdc = code === null ? null : cdcFromText(code.data);
      if (cdc !== null) return cdc;
    }
    return null;
  }

  private decodeRaster(image: Uint8Array): Raster | null {
    if (startsWith(image, PNG_SIGNATURE)) {
      const size = pngDimensions(image);
      if (size === null || !this.withinBudget(size)) return null;
      const decoded = PNG.sync.read(Buffer.from(image.buffer, image.byteOffset, image.length));
      const data = new Uint8Array(decoded.data);
      flattenOnWhite(data);
      return { width: decoded.width, height: decoded.height, data };
    }
    if (image[0] === 0xff && image[1] === 0xd8) {
      const size = jpegDimensions(image);
      if (size === null || !this.withinBudget(size)) return null;
      const decoded = jpeg.decode(image, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: Math.ceil(this.maxPixels / 1_000_000),
      });
      return { width: decoded.width, height: decoded.height, data: decoded.data };
    }
    return null;
  }

  private withinBudget({ width, height }: Dimensions): boolean {
    return width > 0 && height > 0 && width * height <= this.maxPixels;
  }
}

/** The text of a QR code is a SIFEN URL, a percent-encoded URL or a bare CDC; anything else is not ours. */
function cdcFromText(text: string): string | null {
  for (const candidate of [text, safeDecode(text)]) {
    try {
      return extractCdc(candidate);
    } catch {
      // not found in this form: try the next
    }
  }
  return null;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
