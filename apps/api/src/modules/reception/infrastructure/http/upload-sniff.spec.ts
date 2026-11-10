import { describe, expect, it } from 'vitest';
import { sniffUpload } from './upload-sniff.js';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('sniffUpload', () => {
  it('recognizes XML after a BOM and leading whitespace', () => {
    expect(sniffUpload(text('<?xml version="1.0"?><rDE/>'))).toBe('xml');
    expect(sniffUpload(bytes(0xef, 0xbb, 0xbf, 0x0a, 0x20, 0x3c, 0x61))).toBe('xml');
  });

  it('recognizes PDF, PNG and JPEG by magic bytes', () => {
    expect(sniffUpload(text('%PDF-1.4'))).toBe('pdf');
    expect(sniffUpload(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image');
    expect(sniffUpload(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image');
  });

  it('treats anything else, empty included, as unknown', () => {
    expect(sniffUpload(text('hello'))).toBe('unknown');
    expect(sniffUpload(bytes())).toBe('unknown');
    expect(sniffUpload(bytes(0xff, 0xfe, 0x3c, 0x00))).toBe('unknown');
  });
});
