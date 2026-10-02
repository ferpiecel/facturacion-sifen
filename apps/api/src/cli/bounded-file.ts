export type BoundedReadFailure = 'too-large' | 'not-a-file' | 'unreadable';

/** A file could not be read within the allowed size; the message never includes the path or contents. */
export class BoundedReadError extends Error {
  constructor(readonly reason: BoundedReadFailure) {
    super(`file ${reason}`);
    this.name = 'BoundedReadError';
  }
}

/** Reads a regular file of at most `maxBytes`, without ever loading more than `maxBytes + 1`. */
export function readBoundedFile(_path: string, _maxBytes: number): Buffer {
  throw new BoundedReadError('unreadable');
}
