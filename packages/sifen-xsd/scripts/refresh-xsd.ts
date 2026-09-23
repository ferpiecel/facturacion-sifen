import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type ChecksumManifest, readManifest, sha256Hex } from './checksums.ts';

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

export interface ClosureDrift {
  changed: string[];
  added: string[];
  removed: string[];
}

/** Compares freshly fetched bytes against the vendored checksum manifest. */
export function diffClosure(
  manifest: ChecksumManifest,
  fetched: Map<string, Buffer>,
): ClosureDrift {
  const drift: ClosureDrift = { changed: [], added: [], removed: [] };
  for (const [name, bytes] of fetched) {
    if (!(name in manifest)) drift.added.push(name);
    else if (manifest[name] !== sha256Hex(bytes)) drift.changed.push(name);
  }
  drift.removed = Object.keys(manifest).filter((name) => !fetched.has(name));
  return drift;
}

/** Guards against saving an HTML error page served with status 200 as a schema. */
export function assertXsdContent(name: string, bytes: Buffer): void {
  if (!/<([A-Za-z]+:)?schema[\s>/]/.test(bytes.toString('utf8'))) {
    throw new Error(`${name} is not an XSD document`);
  }
}

async function fetchBytes(url: string, name: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`fetch ${url} failed: ${String(response.status)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assertXsdContent(name, bytes);
  return bytes;
}

async function fetchClosure(): Promise<Map<string, Buffer>> {
  const closure = new Map<string, Buffer>();
  const queue = [ROOT_URL];

  for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
    const name = url.slice(url.lastIndexOf('/') + 1);
    if (closure.has(name)) {
      continue;
    }
    const bytes = await fetchBytes(url, name);
    closure.set(name, bytes);
    for (const refName of extractSchemaLocationNames(bytes.toString('utf8'))) {
      if (!closure.has(refName)) {
        queue.push(`${BASE_URL}${refName}`);
      }
    }
  }
  return closure;
}

async function writeVendorFiles(closure: Map<string, Buffer>, vendorDir: string): Promise<void> {
  await mkdir(vendorDir, { recursive: true });
  const manifest: Record<string, string> = {};
  for (const [name, bytes] of closure) {
    await writeFile(join(vendorDir, name), bytes);
    manifest[name] = sha256Hex(bytes);
  }
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(vendorDir, 'checksums.json'), manifestJson, 'utf8');
}

async function main(): Promise<void> {
  const vendorDir = fileURLToPath(new URL('../vendor/', import.meta.url));
  const closure = await fetchClosure();
  const drift = diffClosure(await readManifest(join(vendorDir, 'checksums.json')), closure);
  const report = [
    ...drift.changed.map((name) => `changed: ${name}`),
    ...drift.added.map((name) => `added: ${name}`),
    ...drift.removed.map((name) => `removed: ${name}`),
  ];
  if (report.length === 0) {
    console.log(`refresh-xsd: no drift (${String(closure.size)} files)`);
    return;
  }
  console.log(`refresh-xsd: upstream drift detected\n${report.join('\n')}`);
  if (!process.argv.includes('--update')) {
    process.exitCode = 1;
    return;
  }
  await writeVendorFiles(closure, vendorDir);
  console.log(`refresh-xsd: wrote ${String(closure.size)} files to ${vendorDir}`);
}

const isDirectInvocation = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  void main();
}
