import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../scripts/checksums.ts';
import {
  assertXsdContent,
  diffClosure,
  extractSchemaLocationNames,
} from '../scripts/refresh-xsd.ts';

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

describe('diffClosure', () => {
  const manifest = { 'a.xsd': sha256Hex(Buffer.from('A')), 'b.xsd': sha256Hex(Buffer.from('B')) };

  it('reports no drift when fetched bytes match the manifest', () => {
    const fetched = new Map([
      ['a.xsd', Buffer.from('A')],
      ['b.xsd', Buffer.from('B')],
    ]);

    expect(diffClosure(manifest, fetched)).toEqual({ changed: [], added: [], removed: [] });
  });

  it('reports changed, added and removed files', () => {
    const fetched = new Map([
      ['a.xsd', Buffer.from('A2')],
      ['c.xsd', Buffer.from('C')],
    ]);

    expect(diffClosure(manifest, fetched)).toEqual({
      changed: ['a.xsd'],
      added: ['c.xsd'],
      removed: ['b.xsd'],
    });
  });
});

describe('assertXsdContent', () => {
  it('accepts a schema document', () => {
    expect(() => {
      assertXsdContent('a.xsd', Buffer.from('<?xml version="1.0"?>\n<xs:schema xmlns:xs="x"/>'));
    }).not.toThrow();
  });

  it('rejects an HTML error page served with status 200', () => {
    expect(() => {
      assertXsdContent('a.xsd', Buffer.from('<html><body>Access denied</body></html>'));
    }).toThrow(/a\.xsd is not an XSD/);
  });
});
