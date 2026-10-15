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
  department(code: number): GeoDepartment | undefined;
  district(code: number): GeoDistrict | undefined;
  city(code: number): GeoCity | undefined;
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
  const departmentByCode = new Map(data.departments.map((d) => [d.code, d]));
  const districtByCode = new Map(data.districts.map((d) => [d.code, d]));
  const cityByCode = new Map(data.cities.map((c) => [c.code, c]));
  return {
    departments: () => data.departments,
    districtsOf: (code) => (departmentByCode.has(code) ? (districts.get(code) ?? []) : undefined),
    department: (code) => departmentByCode.get(code),
    district: (code) => districtByCode.get(code),
    city: (code) => cityByCode.get(code),
    citiesOf: (code) => (districtByCode.has(code) ? (cities.get(code) ?? []) : undefined),
  };
}
