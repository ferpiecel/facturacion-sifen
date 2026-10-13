/**
 * cDepEmi (MT v150 §D2, field D111): "Código del departamento de emisión...
 * Según XSD de Departamentos". This is the closed department code table
 * vendored at packages/sifen-xsd/vendor/Departamentos_v141.xsd
 * (`tDepartamentos` / `tDesDepartamento`), transcribed verbatim.
 *
 * cDisEmi (district, D113) and cCiuEmi (city, D115) reference the DNIT geographic
 * reference table (Tabla 2.1), vendored as packages/sifen-xsd/vendor/geo-catalog.json
 * (see its README). District and city validation against it is not wired yet: until then
 * only their format/range is checked (tcDisEmi, tcCiuEmi in DE_Types_v150.xsd).
 */
export const DEPARTMENTS: Readonly<Partial<Record<number, string>>> = {
  1: 'CAPITAL',
  2: 'CONCEPCION',
  3: 'SAN PEDRO',
  4: 'CORDILLERA',
  5: 'GUAIRA',
  6: 'CAAGUAZU',
  7: 'CAAZAPA',
  8: 'ITAPUA',
  9: 'MISIONES',
  10: 'PARAGUARI',
  11: 'ALTO PARANA',
  12: 'CENTRAL',
  13: 'NEEMBUCU',
  14: 'AMAMBAY',
  15: 'PTE. HAYES',
  16: 'BOQUERON',
  17: 'ALTO PARAGUAY',
  18: 'CANINDEYU',
  19: 'CHACO',
  20: 'NUEVA ASUNCION',
};

export class InvalidDepartmentCodeError extends Error {
  constructor(code: number) {
    super(`Invalid department code ${String(code)} (cDepEmi): not in the SIFEN departments table`);
    this.name = 'InvalidDepartmentCodeError';
  }
}

/** Resolves dDesDepEmi (D112) for a cDepEmi code, throwing if the code is not in the closed table. */
export function getDepartmentDescription(code: number): string {
  const description = DEPARTMENTS[code];
  if (description === undefined) {
    throw new InvalidDepartmentCodeError(code);
  }
  return description;
}
