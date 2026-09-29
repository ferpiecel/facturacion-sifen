import { getDepartmentDescription, InvalidDepartmentCodeError } from './department.js';

/** Thrown when an establishment fails format or cross-field validation. */
export class InvalidEstablishmentError extends Error {
  constructor(reason: string) {
    super(`Invalid establishment: ${reason}`);
    this.name = 'InvalidEstablishmentError';
  }
}

// dEst (MT §C005 / XSD tdEst): 3 digits. MT's criteria for HU-E2-02 further
// restrict it to 001-999 (a real code, not all zeros).
const ESTABLISHMENT_CODE_PATTERN = /^(?!000$)\d{3}$/;
// cDisEmi (MT §D2, D113 / XSD tcDisEmi): 1-4 digits, occurrence 0-1.
const DISTRICT_CODE_PATTERN = /^\d{1,4}$/;
// cCiuEmi (MT §D2, D115 / XSD tcCiuEmi): 1-5 digits, occurrence 1-1.
const CITY_CODE_PATTERN = /^\d{1,5}$/;

export interface Establishment {
  /** dEst */
  readonly code: string;
  /** dDirEmi (1-255 chars) */
  readonly address: string;
  /** dNumCas (1-6 digits, "0" when the property has no numbering) */
  readonly houseNumber: string;
  /** dCompDir1, optional */
  readonly addressComplement1: string | null;
  /** dCompDir2, optional */
  readonly addressComplement2: string | null;
  /** cDepEmi */
  readonly departmentCode: number;
  /** dDesDepEmi, derived from departmentCode via the closed table */
  readonly departmentDescription: string;
  /** cDisEmi, optional */
  readonly districtCode: string | null;
  /** dDesDisEmi, required together with districtCode */
  readonly districtDescription: string | null;
  /** cCiuEmi */
  readonly cityCode: string;
  /** dDesCiuEmi */
  readonly cityDescription: string;
}

export interface CreateEstablishmentInput {
  code: string;
  address: string;
  houseNumber: string;
  addressComplement1?: string | null;
  addressComplement2?: string | null;
  departmentCode: number;
  districtCode?: string | null;
  districtDescription?: string | null;
  cityCode: string;
  cityDescription: string;
}

/**
 * Builds an {@link Establishment} (HU-E2-02): validates the 3-digit code,
 * the required address fields, cDepEmi against the closed department table
 * and the district/city codes' format (cDisEmi/cCiuEmi have no official
 * table shipped in this repo — see domain/department.ts).
 */
export function createEstablishment(input: CreateEstablishmentInput): Establishment {
  const code = input.code.trim();
  if (!ESTABLISHMENT_CODE_PATTERN.test(code)) {
    throw new InvalidEstablishmentError(`code "${input.code}" must be 3 digits, 001-999 (dEst)`);
  }

  const address = requireNonEmpty(input.address, 'address (dDirEmi)', 255);
  const houseNumber = requireNonEmpty(input.houseNumber, 'houseNumber (dNumCas)', 6);

  const addressComplement1 = normalizeOptional(input.addressComplement1);
  const addressComplement2 = normalizeOptional(input.addressComplement2);

  const departmentDescription = resolveDepartmentDescription(input.departmentCode);

  const districtCode = normalizeOptional(input.districtCode);
  const districtDescription = normalizeOptional(input.districtDescription);
  if (districtCode !== null && !DISTRICT_CODE_PATTERN.test(districtCode)) {
    throw new InvalidEstablishmentError(
      `districtCode "${districtCode}" must be 1 to 4 digits (cDisEmi)`,
    );
  }
  if ((districtCode === null) !== (districtDescription === null)) {
    throw new InvalidEstablishmentError(
      'districtCode and districtDescription must be provided together (cDisEmi/dDesDisEmi)',
    );
  }

  const cityCode = input.cityCode.trim();
  if (!CITY_CODE_PATTERN.test(cityCode)) {
    throw new InvalidEstablishmentError(`cityCode "${cityCode}" must be 1 to 5 digits (cCiuEmi)`);
  }
  const cityDescription = requireNonEmpty(
    input.cityDescription,
    'cityDescription (dDesCiuEmi)',
    30,
  );

  return {
    code,
    address,
    houseNumber,
    addressComplement1,
    addressComplement2,
    departmentCode: input.departmentCode,
    departmentDescription,
    districtCode,
    districtDescription,
    cityCode,
    cityDescription,
  };
}

function requireNonEmpty(raw: string, field: string, maxLength: number): string {
  const value = raw.trim();
  if (value.length < 1 || value.length > maxLength) {
    throw new InvalidEstablishmentError(`${field} must be 1 to ${String(maxLength)} characters`);
  }
  return value;
}

function resolveDepartmentDescription(departmentCode: number): string {
  try {
    return getDepartmentDescription(departmentCode);
  } catch (error) {
    if (error instanceof InvalidDepartmentCodeError) {
      throw new InvalidEstablishmentError(error.message);
    }
    throw error;
  }
}

function normalizeOptional(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}
