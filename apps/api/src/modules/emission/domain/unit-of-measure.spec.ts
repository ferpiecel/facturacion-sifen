import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isUnitOfMeasureCode, UNIT_OF_MEASURE_CODES } from './unit-of-measure.js';

const XSD = new URL(
  '../../../../../../packages/sifen-xsd/vendor/Unidades_Medida_v141.xsd',
  import.meta.url,
);

/** Spec: HU-E5-01. cUniMed is the closed DNCP list of Unidades_Medida_v141.xsd. */
describe('unit of measure codes', () => {
  it('matches the vendored XSD enumeration exactly', () => {
    const xsd = readFileSync(XSD, 'utf8');
    const block = /<xs:simpleType name="tcUniMed">([\s\S]*?)<\/xs:simpleType>/.exec(xsd)?.[1] ?? '';
    const fromXsd = [...block.matchAll(/enumeration value="(\d+)"/g)].map((m) => Number(m[1]));
    expect(fromXsd.length).toBeGreaterThan(0);
    expect([...UNIT_OF_MEASURE_CODES].sort((a, b) => a - b)).toEqual(fromXsd.sort((a, b) => a - b));
  });

  it('accepts 77 (Unidad) and rejects codes outside the list', () => {
    expect(isUnitOfMeasureCode(77)).toBe(true);
    expect(isUnitOfMeasureCode(1)).toBe(false);
    expect(isUnitOfMeasureCode(77.5)).toBe(false);
  });
});
