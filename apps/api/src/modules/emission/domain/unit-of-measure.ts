/**
 * cUniMed (E007): the closed DNCP list vendored at
 * packages/sifen-xsd/vendor/Unidades_Medida_v141.xsd (`tcUniMed`), kept in sync by its spec.
 * 77 = Unidad, 87 = Metros, 83 = Kilogramos.
 */
export const UNIT_OF_MEASURE_CODES: readonly number[] = [
  87, 2366, 2329, 110, 77, 86, 89, 90, 91, 92, 93, 94, 96, 79, 97, 98, 99, 100, 101, 104, 103, 108,
  109, 95, 666, 102, 83, 88, 625, 660, 885, 891, 869, 569, 111, 112, 113, 114, 115, 116, 117, 118,
  119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137,
  138, 139, 140,
];

const KNOWN = new Set(UNIT_OF_MEASURE_CODES);

export const isUnitOfMeasureCode = (code: number): boolean => KNOWN.has(code);
