import { describe, expect, it } from 'vitest';
import { createEstablishment, InvalidEstablishmentError } from './establishment.js';

function validInput() {
  return {
    code: '001',
    address: 'Avda. Mariscal Lopez',
    houseNumber: '1234',
    addressComplement1: null,
    addressComplement2: null,
    departmentCode: 12,
    districtCode: null,
    districtDescription: null,
    cityCode: '3336',
    cityDescription: 'LAMBARE',
  };
}

describe('createEstablishment', () => {
  it('builds an establishment from valid input, deriving the department description', () => {
    const establishment = createEstablishment(validInput());

    expect(establishment.code).toBe('001');
    expect(establishment.departmentCode).toBe(12);
    expect(establishment.departmentDescription).toBe('CENTRAL');
    expect(establishment.cityCode).toBe('3336');
    expect(establishment.districtCode).toBeNull();
  });

  it('accepts an optional district when its description is also given', () => {
    const establishment = createEstablishment({
      ...validInput(),
      districtCode: '9',
      districtDescription: 'LAMBARE',
    });

    expect(establishment.districtCode).toBe('9');
    expect(establishment.districtDescription).toBe('LAMBARE');
  });

  it('rejects a code that is not exactly 3 digits', () => {
    expect(() => createEstablishment({ ...validInput(), code: '1' })).toThrow(
      InvalidEstablishmentError,
    );
    expect(() => createEstablishment({ ...validInput(), code: '1234' })).toThrow(
      InvalidEstablishmentError,
    );
  });

  it('rejects code "000" (dEst, MT §C005: 001-999)', () => {
    expect(() => createEstablishment({ ...validInput(), code: '000' })).toThrow(
      InvalidEstablishmentError,
    );
  });

  it('rejects a department code outside the closed table', () => {
    expect(() => createEstablishment({ ...validInput(), departmentCode: 99 })).toThrow(
      InvalidEstablishmentError,
    );
  });

  it('rejects a district code without its description', () => {
    expect(() => createEstablishment({ ...validInput(), districtCode: '9' })).toThrow(
      InvalidEstablishmentError,
    );
  });

  it('rejects a district code with the wrong format (cDisEmi: 1-4 digits)', () => {
    expect(() =>
      createEstablishment({ ...validInput(), districtCode: '12345', districtDescription: 'X' }),
    ).toThrow(InvalidEstablishmentError);
  });

  it('rejects a city code with the wrong format (cCiuEmi: 1-5 digits)', () => {
    expect(() => createEstablishment({ ...validInput(), cityCode: '123456' })).toThrow(
      InvalidEstablishmentError,
    );
  });

  it('rejects an empty address', () => {
    expect(() => createEstablishment({ ...validInput(), address: '  ' })).toThrow(
      InvalidEstablishmentError,
    );
  });
});
