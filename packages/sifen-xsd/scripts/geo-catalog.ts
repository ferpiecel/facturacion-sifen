import { inflateRawSync } from 'node:zlib';

/**
 * Pure parsing for the DNIT "CODIGO DE REFERENCIA GEOGRAFICA" workbook (Tabla 2.1): a minimal
 * zip reader and the sheet parser. No I/O, so it is unit tested; the CLI in
 * `build-geo-catalog.ts` wires it to the file system.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Reads every entry of a zip archive (stored or deflated) into memory. */
export function readZipEntries(archive: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = archive.length - 22; i >= 0; i--) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive: end of central directory not found');

  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE)
      throw new Error('corrupt zip directory');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('corrupt zip entry');
    const dataStart =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const body = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(body));
    else if (method === 8) entries.set(name, inflateRawSync(body));
    else throw new Error(`unsupported zip compression method ${String(method)} for ${name}`);
  }
  return entries;
}

export interface GeoRow {
  departmentCode: number;
  departmentName: string;
  districtCode: number;
  districtName: string;
  cityCode: number;
  cityName: string;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};
/** Regex groups that did not participate are `undefined` at runtime. */
const optional = (value: string | undefined): string => value ?? '';
const unescapeXml = (text: string): string =>
  text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) =>
    unescapeXml([...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  );
}

/** Columns of Tabla 2.1: B/C department, D/E district, F/G city (H/I neighbourhood is ignored). */
const COLUMNS = ['B', 'C', 'D', 'E', 'F', 'G'] as const;

function parseCells(
  rowXml: string,
  strings: readonly string[],
  rowNumber: number,
  textCells: Set<string>,
): Map<string, string> {
  const cells = new Map<string, string>();
  for (const cell of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const value = /<v>([\s\S]*?)<\/v>/.exec(optional(cell[3]))?.[1];
    if (value === undefined) continue;
    if (/\bt="s"/.test(cell[2])) {
      const index = Number(value);
      if (!Number.isInteger(index) || index < 0 || index >= strings.length) {
        throw new Error(`row ${String(rowNumber)}: shared string ${value} is out of range`);
      }
      textCells.add(cell[1]);
      cells.set(cell[1], strings[index]);
    } else {
      cells.set(cell[1], value);
    }
  }
  return cells;
}

const toCode = (text: string | undefined, row: number, column: string): number => {
  if (text === undefined || !/^\d+$/.test(text)) {
    throw new Error(`row ${String(row)}: column ${column} is not a numeric code`);
  }
  return Number(text);
};

/**
 * Extracts the department/district/city rows. A data row starts with a numeric department code in
 * column B (a non-integer value there is an error); title, header, blank and self-closing rows
 * are skipped. A data row missing any column is an error.
 */
export function parseGeoSheet(sharedStringsXml: string, sheetXml: string): GeoRow[] {
  const strings = parseSharedStrings(sharedStringsXml);
  const rows: GeoRow[] = [];
  for (const row of sheetXml.matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const number = Number(row[1]);
    const textCells = new Set<string>();
    const cells = parseCells(optional(row[2]), strings, number, textCells);
    // Title and header rows hold text (or nothing) in B; any other value there must be a code.
    if (!cells.has('B') || textCells.has('B')) continue;
    for (const column of COLUMNS) {
      if (!cells.has(column)) throw new Error(`row ${String(number)}: column ${column} is empty`);
    }
    rows.push({
      departmentCode: toCode(cells.get('B'), number, 'B'),
      departmentName: cells.get('C') ?? '',
      districtCode: toCode(cells.get('D'), number, 'D'),
      districtName: cells.get('E') ?? '',
      cityCode: toCode(cells.get('F'), number, 'F'),
      cityName: cells.get('G') ?? '',
    });
  }
  return rows;
}
