import { describe, expect, it } from 'vitest';
import { loadGeoCatalog } from '../src/geo-catalog.ts';

describe('loadGeoCatalog', () => {
  const catalog = loadGeoCatalog();

  it('turns the vendored tuples into named records', () => {
    expect(catalog.departments[0]).toEqual({ code: 1, name: 'CAPITAL' });
    expect(catalog.districts.find((d) => d.code === 145)).toEqual({
      code: 145,
      departmentCode: 11,
      name: 'CIUDAD DEL ESTE',
    });
    expect(catalog.cities.find((c) => c.code === 3432)).toEqual({
      code: 3432,
      districtCode: 145,
      name: 'PUERTO PTE.STROESSNER (MUNIC)',
    });
  });

  it('keeps the sizes of the November 2025 table', () => {
    expect([catalog.departments, catalog.districts, catalog.cities].map((t) => t.length)).toEqual([
      18, 272, 6766,
    ]);
  });
});
