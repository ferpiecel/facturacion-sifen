import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export type BoundedReadFailure = 'too-large' | 'not-a-file' | 'unreadable';

/** A file could not be read within the allowed size; the message never includes the path or contents. */
export class BoundedReadError extends Error {
  constructor(readonly reason: BoundedReadFailure) {
    super(`file ${reason}`);
    this.name = 'BoundedReadError';
  }
}

/**
 * Reads a regular file of at most `maxBytes`, never loading more than `maxBytes + 1` (so a huge
 * or endless file cannot exhaust memory). Operator-supplied paths are not echoed in errors.
 */
export function readBoundedFile(path: string, maxBytes: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    throw new BoundedReadError('unreadable');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new BoundedReadError('not-a-file');
    if (stat.size > maxBytes) throw new BoundedReadError('too-large');
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new BoundedReadError('too-large');
    }
    return Buffer.from(buffer.subarray(0, total));
  } catch (error) {
    if (error instanceof BoundedReadError) throw error;
    throw new BoundedReadError('unreadable');
  } finally {
    closeSync(fd);
  }
}
