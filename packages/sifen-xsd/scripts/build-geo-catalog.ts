import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManifest, sha256Hex } from './checksums.ts';
import { buildCatalog, parseGeoSheet, readZipEntries, serializeCatalog } from './geo-catalog.ts';

/**
 * Generates `vendor/geo-catalog.json` from the DNIT geographic workbook (Tabla 2.1).
 *
 *   node scripts/build-geo-catalog.ts <path-to-xlsx> [--update]
 *
 * The workbook itself is not committed: its identity is pinned by SHA-256 below. Without
 * `--update` the script only checks that the committed dataset is what the workbook produces.
 */
export const SOURCE = {
  url: 'https://www.dnit.gov.py/documents/20123/420592/C%C3%93DIGO+DE+REFERENCIA+GEOGRAFICA_NOVIEMBRE_2025__.xlsx/baf35d49-b6d2-406b-de70-a1d9f63e9e32?t=1769521630085',
  file: 'CÓDIGO DE REFERENCIA GEOGRAFICA_NOVIEMBRE_2025__.xlsx',
  downloadedAt: '2026-10-13',
  sha256: '3918fc3517ce0b5ae883648b9316bbb2583c1b49e614d51d8b441dae978abc16',
} as const;

export const DATASET = 'geo-catalog.json';

export function buildFromWorkbook(workbook: Buffer): string {
  const actual = sha256Hex(workbook);
  if (actual !== SOURCE.sha256) {
    throw new Error(`workbook sha256 ${actual} is not the pinned source ${SOURCE.sha256}`);
  }
  const entries = readZipEntries(workbook);
  const sharedStrings = entries.get('xl/sharedStrings.xml');
  const sheet = entries.get('xl/worksheets/sheet1.xml');
  if (sharedStrings === undefined || sheet === undefined) {
    throw new Error('workbook has no sharedStrings or sheet1');
  }
  const catalog = buildCatalog(
    parseGeoSheet(sharedStrings.toString('utf8'), sheet.toString('utf8')),
  );
  return serializeCatalog(catalog, SOURCE);
}

async function main(): Promise<void> {
  const path = process.argv.at(2);
  if (path === undefined || path.startsWith('--')) {
    throw new Error('usage: node scripts/build-geo-catalog.ts <path-to-xlsx> [--update]');
  }
  const vendorDir = fileURLToPath(new URL('../vendor/', import.meta.url));
  const text = buildFromWorkbook(await readFile(path));
  const datasetPath = join(vendorDir, DATASET);

  if (!process.argv.includes('--update')) {
    const current = await readFile(datasetPath, 'utf8');
    if (current !== text) {
      process.exitCode = 1;
      console.error(`build-geo-catalog: ${DATASET} differs from the workbook (use --update)`);
      return;
    }
    console.log('build-geo-catalog: ok');
    return;
  }

  await writeFile(datasetPath, text, 'utf8');
  const manifestPath = join(vendorDir, 'checksums.json');
  const manifest = {
    ...(await readManifest(manifestPath)),
    [DATASET]: sha256Hex(Buffer.from(text)),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`build-geo-catalog: wrote ${DATASET}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error(String(error));
  });
}
