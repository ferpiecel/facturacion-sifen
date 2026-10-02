import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundedReadError, readBoundedFile } from './bounded-file.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bounded-file-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const failureOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof BoundedReadError) return error.reason;
    throw error;
  }
  return 'none';
};

describe('readBoundedFile (HU-E3-01)', () => {
  it('reads a file up to the limit, inclusive', () => {
    const path = join(dir, 'exact.bin');
    writeFileSync(path, Buffer.alloc(100, 1));
    expect(readBoundedFile(path, 100)).toHaveLength(100);
  });

  it('refuses a file larger than the limit', () => {
    const path = join(dir, 'big.bin');
    writeFileSync(path, Buffer.alloc(101, 1));
    expect(failureOf(() => readBoundedFile(path, 100))).toBe('too-large');
  });

  it('refuses a directory and a missing file with generic reasons', () => {
    expect(failureOf(() => readBoundedFile(dir, 100))).toBe('not-a-file');
    expect(failureOf(() => readBoundedFile(join(dir, 'missing.bin'), 100))).toBe('unreadable');
  });

  it('does not put the path in the error', () => {
    try {
      readBoundedFile(join(dir, 'missing.bin'), 100);
    } catch (error) {
      expect((error as Error).message).not.toContain(dir);
    }
  });
});
