import type { GeoCatalog } from '../../geo/domain/geo-catalog.js';
import type { Establishment } from './establishment.js';

/**
 * Configuration-time check of the issuer address against the DNIT catalog: the codes exist and
 * nest. `xmlgen` writes the issuer department, district and city text from its table (not from
 * the establishment), and an establishment it cannot resolve parks every document at signing, so
 * it is refused when configured. Returns the problems; empty means coherent.
 */
export function validateEstablishmentGeography(
  establishment: Establishment,
  catalog: GeoCatalog,
): string[] {
  const problems: string[] = [];
  const { departmentCode } = establishment;
  const districtCode =
    establishment.districtCode === null ? undefined : Number(establishment.districtCode);
  const cityCode = Number(establishment.cityCode);
  const district = districtCode === undefined ? undefined : catalog.district(districtCode);
  const city = catalog.city(cityCode);

  if (districtCode !== undefined && district === undefined) {
    problems.push(`districtCode ${String(districtCode)} is not in the DNIT table`);
  }
  if (city === undefined) problems.push(`cityCode ${String(cityCode)} is not in the DNIT table`);
  if (district && district.departmentCode !== departmentCode) {
    problems.push(
      `district ${String(district.code)} does not belong to department ${String(departmentCode)}`,
    );
  }
  if (district && city && city.districtCode !== district.code) {
    problems.push(`city ${String(city.code)} does not belong to district ${String(district.code)}`);
  }
  if (districtCode === undefined && city) {
    if (catalog.district(city.districtCode)?.departmentCode !== departmentCode) {
      problems.push(
        `city ${String(city.code)} does not belong to department ${String(departmentCode)}`,
      );
    }
  }
  return problems;
}
