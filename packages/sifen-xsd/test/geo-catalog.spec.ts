import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  parseGeoSheet,
  readZipEntries,
  serializeCatalog,
  type GeoRow,
} from '../scripts/geo-catalog.ts';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Minimal zip writer: `deflated` entries use method 8, the others are stored (method 0). */
function zip(files: { name: string; data: string; deflated: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data, 'utf8');
    const body = file.deflated ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.deflated ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(file.deflated ? 8 : 0, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

describe('readZipEntries', () => {
  it('reads stored and deflated entries by name', () => {
    const archive = zip([
      { name: 'a.txt', data: 'stored text', deflated: false },
      { name: 'xl/b.xml', data: '<x>deflated ñ</x>'.repeat(20), deflated: true },
    ]);

    const entries = readZipEntries(archive);

    expect(entries.get('a.txt')?.toString('utf8')).toBe('stored text');
    expect(entries.get('xl/b.xml')?.toString('utf8')).toBe('<x>deflated ñ</x>'.repeat(20));
  });

  it('rejects a buffer that is not a zip archive', () => {
    expect(() => readZipEntries(Buffer.from('not a zip'))).toThrow(/zip/);
  });
});

const strings = [
  'Código',
  'Departamento',
  'CAPITAL',
  "REPUBLICANO 'A'",
  'ASUNCION (DISTRITO)',
  'A &amp; B',
];
const sharedStrings = `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`.replace(
  '<si><t>CAPITAL</t></si>',
  '<si><r><t>CAPI</t></r><r><t>TAL</t></r></si>',
);
const cell = (ref: string, value: number | string) =>
  typeof value === 'string'
    ? `<c r="${ref}" t="s"><v>${String(strings.indexOf(value))}</v></c>`
    : `<c r="${ref}"><v>${String(value)}</v></c>`;
const row = (n: number, cells: [string, number | string][]) =>
  `<row r="${String(n)}">${cells.map(([col, v]) => cell(`${col}${String(n)}`, v)).join('')}</row>`;

describe('parseGeoSheet', () => {
  const sheet = `<worksheet><sheetData>
    ${row(14, [
      ['B', 'Código'],
      ['C', 'Departamento'],
    ])}
    <row r="15"><c r="B15" s="3"/></row>
    ${row(16, [
      ['B', 1],
      ['C', 'CAPITAL'],
      ['D', 1],
      ['E', 'ASUNCION (DISTRITO)'],
      ['F', 1],
      ['G', 'A &amp; B'],
      ['H', 1],
      ['I', "REPUBLICANO 'A'"],
    ])}
    </sheetData></worksheet>`;

  it('skips headers, joins rich-text strings and unescapes entities', () => {
    expect(parseGeoSheet(sharedStrings, sheet)).toEqual<GeoRow[]>([
      {
        departmentCode: 1,
        departmentName: 'CAPITAL',
        districtCode: 1,
        districtName: 'ASUNCION (DISTRITO)',
        cityCode: 1,
        cityName: 'A & B',
      },
    ]);
  });

  it('fails when a data row misses a column instead of guessing', () => {
    const broken = `<worksheet><sheetData>${row(16, [
      ['B', 1],
      ['C', 'CAPITAL'],
      ['D', 1],
    ])}</sheetData></worksheet>`;

    expect(() => parseGeoSheet(sharedStrings, broken)).toThrow(/row 16/);
  });
});

const rows = (...specs: [number, string, number, string, number, string][]): GeoRow[] =>
  specs.map(([departmentCode, departmentName, districtCode, districtName, cityCode, cityName]) => ({
    departmentCode,
    departmentName,
    districtCode,
    districtName,
    cityCode,
    cityName,
  }));

describe('buildCatalog', () => {
  it('deduplicates the parents repeated on every row and sorts by code', () => {
    const catalog = buildCatalog(
      rows(
        [2, 'CONCEPCION', 2, 'CONCEPCION (MUNICIPIO)', 100, 'LOMA PYTA'],
        [1, 'CAPITAL', 1, 'ASUNCION (DISTRITO)', 1, 'ASUNCION (DISTRITO)'],
        [1, 'CAPITAL', 1, 'ASUNCION (DISTRITO)', 1, 'ASUNCION (DISTRITO)'],
        [2, 'CONCEPCION', 2, 'CONCEPCION (MUNICIPIO)', 99, 'LOMA'],
      ),
    );

    expect(catalog.departments).toEqual([
      { code: 1, name: 'CAPITAL' },
      { code: 2, name: 'CONCEPCION' },
    ]);
    expect(catalog.districts).toEqual([
      { code: 1, departmentCode: 1, name: 'ASUNCION (DISTRITO)' },
      { code: 2, departmentCode: 2, name: 'CONCEPCION (MUNICIPIO)' },
    ]);
    expect(catalog.cities.map((c) => c.code)).toEqual([1, 99, 100]);
  });

  it('rejects one code with two names', () => {
    expect(() =>
      buildCatalog(rows([1, 'CAPITAL', 1, 'A', 1, 'X'], [1, 'CAPITAL', 1, 'B', 2, 'Y'])),
    ).toThrow(/district 1/);
  });

  it('rejects a district code under two departments and a city code under two districts', () => {
    expect(() => buildCatalog(rows([1, 'D1', 5, 'A', 1, 'X'], [2, 'D2', 5, 'A', 2, 'Y']))).toThrow(
      /district 5/,
    );
    expect(() => buildCatalog(rows([1, 'D1', 5, 'A', 1, 'X'], [1, 'D1', 6, 'B', 1, 'X']))).toThrow(
      /city 1/,
    );
  });
});

describe('serializeCatalog', () => {
  const source = {
    url: 'https://example.test/file.xlsx',
    file: 'file.xlsx',
    downloadedAt: '2026-10-13',
    sha256: 'ab'.repeat(32),
  };

  it('is deterministic and one entry per line', () => {
    const a = buildCatalog(rows([1, 'CAPITAL', 1, 'A', 1, 'X'], [2, 'D2', 2, 'B', 2, 'Y']));
    const b = buildCatalog(rows([2, 'D2', 2, 'B', 2, 'Y'], [1, 'CAPITAL', 1, 'A', 1, 'X']));

    const text = serializeCatalog(a, source);

    expect(text).toBe(serializeCatalog(b, source));
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      source,
      departments: [
        [1, 'CAPITAL'],
        [2, 'D2'],
      ],
      districts: [
        [1, 1, 'A'],
        [2, 2, 'B'],
      ],
      cities: [
        [1, 1, 'X'],
        [2, 2, 'Y'],
      ],
    });
    expect(text.split('\n').length).toBeGreaterThan(10);
  });
});
