import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManifest, sha256File } from './checksums.ts';

const MANIFEST_FILE = 'checksums.json';
const IGNORED_FILES = new Set([MANIFEST_FILE, 'README.md']);

export interface VerifyResult {
  readonly ok: boolean;
  readonly mismatched: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/**
 * Verifies every file under `vendorDir` (except the manifest itself) against
 * the sha256 recorded in `checksums.json`, and reports files that are
 * missing or untracked relative to the manifest.
 */
export async function verifyVendorDirectory(vendorDir: string): Promise<VerifyResult> {
  const manifest = await readManifest(join(vendorDir, MANIFEST_FILE));
  const entries = (await readdir(vendorDir)).filter((name) => !IGNORED_FILES.has(name));

  const expectedNames = new Set(Object.keys(manifest));
  const actualNames = new Set(entries);

  const missing = [...expectedNames].filter((name) => !actualNames.has(name)).sort();
  const extra = [...actualNames].filter((name) => !expectedNames.has(name)).sort();

  const mismatched: string[] = [];
  for (const name of entries) {
    if (!expectedNames.has(name)) {
      continue;
    }
    const actualHash = await sha256File(join(vendorDir, name));
    if (actualHash !== manifest[name]) {
      mismatched.push(name);
    }
  }
  mismatched.sort();

  return {
    ok: mismatched.length === 0 && missing.length === 0 && extra.length === 0,
    mismatched,
    missing,
    extra,
  };
}

export function resultExitCode(result: VerifyResult): 0 | 1 {
  return result.ok ? 0 : 1;
}

export function formatVerifyResult(result: VerifyResult): string {
  const lines: string[] = [
    ...result.mismatched.map((name) => `checksum mismatch: ${name}`),
    ...result.missing.map((name) => `missing vendored file: ${name}`),
    ...result.extra.map((name) => `untracked vendored file: ${name}`),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const vendorDir = fileURLToPath(new URL('../vendor/', import.meta.url));
  const result = await verifyVendorDirectory(vendorDir);
  process.exitCode = resultExitCode(result);
  if (!result.ok) {
    console.error(formatVerifyResult(result));
    return;
  }
  console.log('verify-vendor: ok');
}

const isDirectInvocation = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  void main();
}
