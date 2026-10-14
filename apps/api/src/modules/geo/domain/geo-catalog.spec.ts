import { describe, expect, it } from 'vitest';
import { createGeoCatalog } from './geo-catalog.js';

const catalog = createGeoCatalog({
  departments: [
    { code: 1, name: 'CAPITAL' },
    { code: 2, name: 'CONCEPCION' },
  ],
  districts: [
    { code: 1, departmentCode: 1, name: 'ASUNCION (DISTRITO)' },
    { code: 2, departmentCode: 2, name: 'CONCEPCION (MUNICIPIO)' },
    { code: 3, departmentCode: 2, name: 'BELEN' },
  ],
  cities: [
    { code: 10, districtCode: 2, name: 'LOMA' },
    { code: 11, districtCode: 2, name: 'LLANO' },
    { code: 12, districtCode: 3, name: 'BELEN' },
  ],
});

describe('createGeoCatalog', () => {
  it('lists every department', () => {
    expect(catalog.departments().map((d) => d.code)).toEqual([1, 2]);
  });

  it('lists only the districts of a department, and the cities of a district', () => {
    expect(catalog.districtsOf(2)?.map((d) => d.code)).toEqual([2, 3]);
    expect(catalog.citiesOf(2)?.map((c) => c.name)).toEqual(['LOMA', 'LLANO']);
  });

  it('distinguishes an empty parent from an unknown one', () => {
    expect(catalog.districtsOf(1)).toHaveLength(1);
    expect(catalog.districtsOf(99)).toBeUndefined();
    expect(catalog.citiesOf(1)).toEqual([]);
    expect(catalog.citiesOf(99)).toBeUndefined();
  });
});
