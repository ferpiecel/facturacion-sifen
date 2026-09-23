import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256Hex } from './checksums.ts';

const ROOT_URL = 'https://ekuatia.set.gov.py/sifen/xsd/siRecepDE_v150.xsd';
const BASE_URL = 'https://ekuatia.set.gov.py/sifen/xsd/';

const SCHEMA_LOCATION_PATTERN = /schemaLocation\s*=\s*"([^"]+)"/g;

/**
 * Parses `xsd:include`/`xsd:import` `schemaLocation` references out of raw
 * XSD text and returns the bare filename for each one, in document order.
 * Tolerant of whitespace around `=`. Resolves both absolute https URLs and
 * already-relative names to their bare filename.
 */
export function extractSchemaLocationNames(xsdContent: string): string[] {
  const names: string[] = [];
  for (const match of xsdContent.matchAll(SCHEMA_LOCATION_PATTERN)) {
    const location = match[1];
    const name = location.includes('/') ? location.slice(location.lastIndexOf('/') + 1) : location;
    names.push(name);
  }
  return names;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`fetch ${url} failed: ${String(response.status)}`);
  }
  return response.text();
}

async function fetchClosure(): Promise<Map<string, string>> {
  const closure = new Map<string, string>();
  const queue = [ROOT_URL];

  let url = queue.shift();
  while (url !== undefined) {
    const name = url.slice(url.lastIndexOf('/') + 1);
    if (closure.has(name)) {
      url = queue.shift();
      continue;
    }
    const content = await fetchText(url);
    closure.set(name, content);
    for (const refName of extractSchemaLocationNames(content)) {
      if (!closure.has(refName)) {
        queue.push(`${BASE_URL}${refName}`);
      }
    }
    url = queue.shift();
  }
  return closure;
}

async function writeVendorFiles(closure: Map<string, string>, vendorDir: string): Promise<void> {
  await mkdir(vendorDir, { recursive: true });
  const manifest: Record<string, string> = {};
  for (const [name, content] of closure) {
    const buffer = Buffer.from(content, 'utf8');
    await writeFile(join(vendorDir, name), buffer);
    manifest[name] = sha256Hex(buffer);
  }
  await writeFile(
    join(vendorDir, 'checksums.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update');
  const vendorDir = fileURLToPath(new URL('../vendor/', import.meta.url));
  const closure = await fetchClosure();

  if (!update) {
    throw new Error(
      'refresh-xsd: pass --update to write vendor/ (drift check without --update is not implemented)',
    );
  }

  await writeVendorFiles(closure, vendorDir);
  console.log(`refresh-xsd: wrote ${String(closure.size)} files to ${vendorDir}`);
}

const isDirectInvocation = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  void main();
}
