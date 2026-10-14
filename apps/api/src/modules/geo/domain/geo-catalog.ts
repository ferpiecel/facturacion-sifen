/** DNIT geographic reference table (Tabla 2.1): department > district > city. */
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

export interface GeoCatalog {
  departments(): readonly GeoDepartment[];
  /** `undefined` when the department does not exist; an empty list when it has no districts. */
  districtsOf(departmentCode: number): readonly GeoDistrict[] | undefined;
  /** `undefined` when the district does not exist. */
  citiesOf(districtCode: number): readonly GeoCity[] | undefined;
}

function groupBy<T>(items: readonly T[], key: (item: T) => number): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Indexes the table once; lookups never expose the whole city list. */
export function createGeoCatalog(data: GeoCatalogData): GeoCatalog {
  const districts = groupBy(data.districts, (d) => d.departmentCode);
  const cities = groupBy(data.cities, (c) => c.districtCode);
  const departmentCodes = new Set(data.departments.map((d) => d.code));
  const districtCodes = new Set(data.districts.map((d) => d.code));
  return {
    departments: () => data.departments,
    districtsOf: (code) => (departmentCodes.has(code) ? (districts.get(code) ?? []) : undefined),
    citiesOf: (code) => (districtCodes.has(code) ? (cities.get(code) ?? []) : undefined),
  };
}
