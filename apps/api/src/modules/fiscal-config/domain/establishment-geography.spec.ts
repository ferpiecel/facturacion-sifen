import { loadGeoCatalog } from '@sifen/sifen-xsd';
import { describe, expect, it } from 'vitest';
import { createGeoCatalog } from '../../geo/domain/geo-catalog.js';
import { createEstablishment, type CreateEstablishmentInput } from './establishment.js';
import { validateEstablishmentGeography } from './establishment-geography.js';

const catalog = createGeoCatalog(loadGeoCatalog());

/** Ciudad del Este: department 11, district 145, city 3383. */
const establishment = (overrides: Partial<CreateEstablishmentInput> = {}) =>
  createEstablishment({
    code: '001',
    address: 'Av. Principal',
    houseNumber: '1',
    departmentCode: 11,
    districtCode: '145',
    districtDescription: 'CIUDAD DEL ESTE',
    cityCode: '3383',
    cityDescription: 'CIUDAD DEL ESTE',
    ...overrides,
  });

describe('validateEstablishmentGeography (xmlgen writes the issuer text from the catalog)', () => {
  it('accepts codes that exist and nest', () => {
    expect(validateEstablishmentGeography(establishment(), catalog)).toEqual([]);
  });

  it('accepts an establishment without district when the city sits in the department', () => {
    const e = establishment({ districtCode: null, districtDescription: null });

    expect(validateEstablishmentGeography(e, catalog)).toEqual([]);
  });

  it('rejects an unknown city or district', () => {
    expect(validateEstablishmentGeography(establishment({ cityCode: '99999' }), catalog)).toEqual([
      expect.stringContaining('cityCode'),
    ]);
    expect(
      validateEstablishmentGeography(establishment({ districtCode: '9999' }), catalog),
    ).toEqual(expect.arrayContaining([expect.stringContaining('districtCode')]));
  });

  it('rejects a city outside the district and a district outside the department', () => {
    expect(validateEstablishmentGeography(establishment({ cityCode: '3316' }), catalog)).toEqual([
      expect.stringContaining('city 3316 does not belong to district 145'),
    ]);
    expect(validateEstablishmentGeography(establishment({ departmentCode: 1 }), catalog)).toEqual([
      expect.stringContaining('district 145 does not belong to department 1'),
    ]);
  });

  it('rejects a city outside the department when there is no district', () => {
    const e = establishment({ departmentCode: 1, districtCode: null, districtDescription: null });

    expect(validateEstablishmentGeography(e, catalog)).toEqual([
      expect.stringContaining('city 3383 does not belong to department 1'),
    ]);
  });
});
