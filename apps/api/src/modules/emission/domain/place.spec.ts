import { describe, expect, it } from 'vitest';
import { createGeoCatalog } from '../../geo/domain/geo-catalog.js';
import { validatePlace } from './place.js';

const catalog = createGeoCatalog({
  departments: [
    { code: 11, name: 'ALTO PARANA' },
    { code: 1, name: 'CONCEPCION' },
  ],
  districts: [
    { code: 143, departmentCode: 11, name: 'DOMINGO MARTINEZ DE IRALA' },
    { code: 1, departmentCode: 1, name: 'CONCEPCION' },
  ],
  cities: [{ code: 3344, districtCode: 143, name: 'PASO ITA' }],
});
const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};

/** Spec: MT v150 E308-E322 and E921-E950, the place blocks of the AFE and the NRE (2553, 2557, 2153). */
describe('validatePlace', () => {
  it('accepts a coherent place with and without the DNIT table', () => {
    expect(validatePlace('seller', place, {})).toEqual([]);
    expect(validatePlace('seller', place, { geoCatalog: catalog, validateGeo: true })).toEqual([]);
  });

  it('rejects a department outside the SIFEN table even without the catalog', () => {
    const errors = validatePlace('seller', { ...place, departmentCode: 99 }, {});
    expect(errors).toEqual([
      expect.objectContaining({ field: 'seller.departmentCode', rule: 'seller-department-code' }),
    ]);
  });

  it('rejects codes that do not nest when the catalog is on, naming the block', () => {
    const errors = validatePlace(
      'place',
      { ...place, departmentCode: 1 },
      { geoCatalog: catalog, validateGeo: true },
    );
    expect(errors.map((e) => e.rule)).toEqual(['place-district-not-in-department']);
    const unknown = validatePlace(
      'place',
      { ...place, cityCode: 1 },
      { geoCatalog: catalog, validateGeo: true },
    );
    expect(unknown.map((e) => e.rule)).toEqual(['place-city-unknown']);
    const apart = validatePlace(
      'place',
      { ...place, districtCode: 1 },
      { geoCatalog: catalog, validateGeo: true },
    );
    expect(apart.map((e) => e.rule)).toEqual([
      'place-city-not-in-district',
      'place-district-not-in-department',
    ]);
  });
});
