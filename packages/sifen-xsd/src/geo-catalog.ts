import { readFileSync } from 'node:fs';
import { vendorDir } from './schemas.ts';

export interface GeoDepartment {
  readonly code: number;
  readonly name: string;
}
export interface GeoDistrict {
  readonly code: number;
  readonly departmentCode: number;
  readonly name: string;
}
export interface GeoCity {
  readonly code: number;
  readonly districtCode: number;
  readonly name: string;
}
export interface GeoCatalogData {
  readonly departments: readonly GeoDepartment[];
  readonly districts: readonly GeoDistrict[];
  readonly cities: readonly GeoCity[];
}

interface Stored {
  departments: [number, string][];
  districts: [number, number, string][];
  cities: [number, number, string][];
}

/** Reads the vendored DNIT geographic table (`vendor/geo-catalog.json`, Tabla 2.1). */
export function loadGeoCatalog(): GeoCatalogData {
  const stored = JSON.parse(readFileSync(`${vendorDir}geo-catalog.json`, 'utf8')) as Stored;
  return {
    departments: stored.departments.map(([code, name]) => ({ code, name })),
    districts: stored.districts.map(([code, departmentCode, name]) => ({
      code,
      departmentCode,
      name,
    })),
    cities: stored.cities.map(([code, districtCode, name]) => ({ code, districtCode, name })),
  };
}
