import { describe, expect, it } from 'vitest';
import { SifenTimeoutError, SifenTransportError } from '../src/errors.ts';

describe('SifenTimeoutError', () => {
  it('is an Error instance with the failing operation and an optional cause', () => {
    const cause = new Error('socket hang up');
    const error = new SifenTimeoutError('consultarRUC', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SifenTimeoutError);
    expect(error.name).toBe('SifenTimeoutError');
    expect(error.operation).toBe('consultarRUC');
    expect(error.cause).toBe(cause);
  });
});

describe('SifenTransportError', () => {
  it('is an Error instance with the failing operation and an optional cause', () => {
    const cause = new Error('ECONNRESET');
    const error = new SifenTransportError('enviarLote', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SifenTransportError);
    expect(error.name).toBe('SifenTransportError');
    expect(error.operation).toBe('enviarLote');
    expect(error.cause).toBe(cause);
  });
});
