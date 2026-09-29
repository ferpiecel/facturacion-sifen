import { describe, expect, it } from 'vitest';
import { createTimbrado, InvalidTimbradoError } from './timbrado.js';

describe('createTimbrado', () => {
  it('builds a timbrado with only a validity start date', () => {
    const timbrado = createTimbrado({ number: '12345678', validityStart: '2024-01-15' });

    expect(timbrado.number).toBe('12345678');
    expect(timbrado.validityStart).toBe('2024-01-15');
    expect(timbrado.validityEnd).toBeNull();
  });

  it('builds a timbrado with a validity end on or after the start', () => {
    const timbrado = createTimbrado({
      number: '12345678',
      validityStart: '2024-01-15',
      validityEnd: '2024-01-15',
    });

    expect(timbrado.validityEnd).toBe('2024-01-15');
  });

  it('accepts a leading-zero number that is not all zeros (dNumTim, XSD tdNumTim)', () => {
    expect(createTimbrado({ number: '00012345', validityStart: '2024-01-15' }).number).toBe(
      '00012345',
    );
  });

  it('rejects a number that is not exactly 8 digits', () => {
    expect(() => createTimbrado({ number: '1234567', validityStart: '2024-01-15' })).toThrow(
      InvalidTimbradoError,
    );
    expect(() => createTimbrado({ number: '123456789', validityStart: '2024-01-15' })).toThrow(
      InvalidTimbradoError,
    );
  });

  it('rejects an all-zero number', () => {
    expect(() => createTimbrado({ number: '00000000', validityStart: '2024-01-15' })).toThrow(
      InvalidTimbradoError,
    );
  });

  it('rejects a validity start before 2018-05-01 (dFeIniT, XSD minInclusive)', () => {
    expect(() => createTimbrado({ number: '12345678', validityStart: '2018-04-30' })).toThrow(
      InvalidTimbradoError,
    );
  });

  it('rejects a malformed validity start date', () => {
    expect(() => createTimbrado({ number: '12345678', validityStart: '2024-13-01' })).toThrow(
      InvalidTimbradoError,
    );
  });

  it('rejects a validity end before the validity start', () => {
    expect(() =>
      createTimbrado({
        number: '12345678',
        validityStart: '2024-01-15',
        validityEnd: '2024-01-14',
      }),
    ).toThrow(InvalidTimbradoError);
  });
});
