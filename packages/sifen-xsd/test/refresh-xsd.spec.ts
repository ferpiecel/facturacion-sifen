import { describe, expect, it } from 'vitest';
import { extractSchemaLocationNames } from '../scripts/refresh-xsd.ts';

describe('extractSchemaLocationNames', () => {
  it('extracts a relative schemaLocation name', () => {
    const xsd = '<xsd:include schemaLocation="xmldsig-core-schema.xsd"/>';

    expect(extractSchemaLocationNames(xsd)).toEqual(['xmldsig-core-schema.xsd']);
  });

  it('extracts the bare filename from an absolute https schemaLocation', () => {
    const xsd =
      '<xsd:import schemaLocation="https://ekuatia.set.gov.py/sifen/xsd/Paises_v100.xsd"/>';

    expect(extractSchemaLocationNames(xsd)).toEqual(['Paises_v100.xsd']);
  });

  it('tolerates whitespace around the `=` sign', () => {
    const xsd = '<xsd:import schemaLocation = "Monedas_v150.xsd"/>';

    expect(extractSchemaLocationNames(xsd)).toEqual(['Monedas_v150.xsd']);
  });

  it('returns one entry per reference, in document order, without deduplicating', () => {
    const xsd = [
      '<xsd:include schemaLocation="xmldsig-core-schema.xsd"/>',
      '<xsd:import schemaLocation="https://ekuatia.set.gov.py/sifen/xsd/Paises_v100.xsd"/>',
      '<xsd:import schemaLocation="https://ekuatia.set.gov.py/sifen/xsd/Paises_v100.xsd"/>',
    ].join('\n');

    expect(extractSchemaLocationNames(xsd)).toEqual([
      'xmldsig-core-schema.xsd',
      'Paises_v100.xsd',
      'Paises_v100.xsd',
    ]);
  });

  it('returns an empty array when there is no schemaLocation reference', () => {
    expect(extractSchemaLocationNames('<xsd:schema/>')).toEqual([]);
  });
});
