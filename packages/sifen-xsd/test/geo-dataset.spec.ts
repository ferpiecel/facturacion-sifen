import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DATASET, SOURCE } from '../scripts/build-geo-catalog.ts';
import { sha256Hex } from '../scripts/checksums.ts';

const vendor = new URL('../vendor/', import.meta.url);

interface Dataset {
  source: typeof SOURCE;
  departments: [number, string][];
  districts: [number, number, string][];
  cities: [number, number, string][];
}

async function load(): Promise<{ text: string; data: Dataset }> {
  const text = await readFile(new URL(DATASET, vendor), 'utf8');
  return { text, data: JSON.parse(text) as Dataset };
}

describe('vendored geographic catalog (DNIT Tabla 2.1)', () => {
  it('records the source workbook and matches the manifest checksum', async () => {
    const { text, data } = await load();
    const manifest = JSON.parse(
      await readFile(new URL('checksums.json', vendor), 'utf8'),
    ) as Record<string, string>;

    expect(data.source).toEqual(SOURCE);
    expect(manifest[DATASET]).toBe(sha256Hex(Buffer.from(text, 'utf8')));
  });

  it('has the expected sizes for the November 2025 workbook', async () => {
    const { data } = await load();

    expect(data.departments).toHaveLength(18);
    expect(data.districts).toHaveLength(272);
    expect(data.cities).toHaveLength(6766);
  });

  it('is sorted by code with unique codes and valid parents', async () => {
    const { data } = await load();
    const departments = new Set(data.departments.map(([code]) => code));
    const districts = new Set(data.districts.map(([code]) => code));

    for (const table of [data.departments, data.districts, data.cities]) {
      const codes = table.map(([code]) => code);
      expect(codes).toEqual([...new Set(codes)].sort((a, b) => a - b));
    }
    expect(data.districts.every(([, parent]) => departments.has(parent))).toBe(true);
    expect(data.cities.every(([, parent]) => districts.has(parent))).toBe(true);
  });

  it('agrees with the department names of Departamentos_v141.xsd', async () => {
    const { data } = await load();
    const xsd = await readFile(new URL('Departamentos_v141.xsd', vendor), 'utf8');
    const official = new Map(
      [
        ...xsd.matchAll(
          /enumeration value="(\d+)">\s*<xs:annotation>\s*<xs:documentation>([^<]*)</g,
        ),
      ].map((m) => [Number(m[1]), m[2].trim()]),
    );

    for (const [code, name] of data.departments) expect(official.get(code)).toBe(name);
  });
});
