import { DEPARTMENTS } from '../../fiscal-config/domain/department.js';
import type { ValidationConfig, ValidationError } from './invoice-draft.js';

/** A street address with its department, district and city (E308-E315, E316-E322, E921-E930, E941-E950). */
export interface Place {
  address: string;
  /** dNumCas*: 1 to 6 digits, `0` when the place has no number. */
  houseNumber: string;
  departmentCode: number;
  districtCode: number;
  cityCode: number;
}

/**
 * Codes of a place block. The department must be in the SIFEN table; with the DNIT catalog and
 * `validateGeo` the district must sit in the department and the city in the district (2553, 2557,
 * 2153). `block` names the field (`seller`, `place`, `transport.departure`) and prefixes the rules.
 */
export function validatePlace(
  block: string,
  place: Place,
  config: ValidationConfig,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const add = (field: string, rule: string, message: string) => {
    errors.push({ field: `${block}.${field}`, rule: `${block}-${rule}`, message });
  };
  if (DEPARTMENTS[place.departmentCode] === undefined) {
    add(
      'departmentCode',
      'department-code',
      'Department code is not in the SIFEN departments table',
    );
  }
  const catalog = config.validateGeo ? config.geoCatalog : undefined;
  if (!catalog) return errors;
  const district = catalog.district(place.districtCode);
  const city = catalog.city(place.cityCode);
  if (!district) add('districtCode', 'district-unknown', 'The district is not in the DNIT table');
  if (!city) add('cityCode', 'city-unknown', 'The city is not in the DNIT table');
  if (district && city && city.districtCode !== district.code) {
    add('cityCode', 'city-not-in-district', 'The city does not belong to the district');
  }
  if (district && district.departmentCode !== place.departmentCode) {
    add(
      'districtCode',
      'district-not-in-department',
      'The district does not belong to the department',
    );
  }
  return errors;
}
