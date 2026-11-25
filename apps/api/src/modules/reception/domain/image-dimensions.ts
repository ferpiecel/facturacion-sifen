/** Pixel size read from an image header, without decoding any pixel. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
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

export function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const isIhdr = bytes.length >= 24 && readU32(bytes, 8) === 13 && bytes[12] === 0x49;
  if (!isIhdr || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  return { width: readU32(bytes, 16), height: readU32(bytes, 20) };
}

/**
 * Walks the JPEG marker segments up to the scan. A baseline or progressive JPEG has exactly one
 * start-of-frame header; an image with a second one is hostile (a decoder may honour a different
 * frame than the one the guard read), so it is refused.
 */
export function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let frame: ImageDimensions | null = null;
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
      if (frame !== null || at + 9 > bytes.length) return null;
      frame = { height: readU16(bytes, at + 5), width: readU16(bytes, at + 7) };
    } else if (marker === 0xd9 || marker === 0xda) {
      return frame; // end of image / start of scan: no more headers to inspect
    }
    at += 2 + readU16(bytes, at + 2);
  }
  return null;
}

/** Dimensions declared by a PNG or JPEG header; null for any other format or a broken header. */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngDimensions(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
  return null;
}
