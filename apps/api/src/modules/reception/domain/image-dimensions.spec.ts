import { describe, expect, it } from 'vitest';
import { imageDimensions } from './image-dimensions.js';

function png(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('imageDimensions', () => {
  it('reads the PNG header size', () => {
    expect(imageDimensions(png(8000, 5000))).toEqual({ width: 8000, height: 5000 });
  });

  it('reads the JPEG start-of-frame size', () => {
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x20, 0x01, 0, 0, 0, 0xff, 0xd9,
      0, 0,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 32, height: 16 });
  });

  it('is null for unknown formats and broken headers', () => {
    expect(imageDimensions(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(imageDimensions(Uint8Array.from([0x89, 0x50, 1, 2]))).toBeNull();
  });
});
