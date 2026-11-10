export type UploadKind = 'xml' | 'pdf' | 'image' | 'unknown';

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean =>
  prefix.every((byte, index) => bytes[offset + index] === byte);

/** First non-whitespace offset after an optional UTF-8 BOM. */
function contentStart(bytes: Uint8Array): number {
  let index = startsWith(bytes, UTF8_BOM) ? UTF8_BOM.length : 0;
  while (index < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[index])) index++;
  return index;
}

/**
 * Classifies an upload by its leading bytes, never by the declared content type. "xml" only means
 * the first significant byte opens a tag; the parser still decides whether it is a SIFEN document.
 */
export function sniffUpload(bytes: Uint8Array): UploadKind {
  if (startsWith(bytes, PDF)) return 'pdf';
  if (startsWith(bytes, PNG) || startsWith(bytes, JPEG)) return 'image';
  return bytes[contentStart(bytes)] === 0x3c ? 'xml' : 'unknown';
}
